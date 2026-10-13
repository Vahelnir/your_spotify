import { Types } from "mongoose";

import { getUserFromField, storeInUser } from "../../database";
import { SpotifyAlbum } from "../../database/schemas/album";
import { SpotifyArtist } from "../../database/schemas/artist";
import { SpotifyTrack } from "../../database/schemas/track";
import { logger } from "../logger";
import { chunk } from "../misc";
import { spotifyProvider } from "../oauth/Provider";
import { HttpError } from "./queueHttpClient";

export interface SpotifyMe {
  id: string;
  display_name: string;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: { id: string };
}

export class SpotifyAPI {
  constructor(private readonly userId: string) {}

  private async checkToken() {
    const user = await getUserFromField(
      "_id",
      new Types.ObjectId(this.userId),
      true,
    );
    let access: string | null | undefined = user?.accessToken;
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.spotifyId) {
      throw new Error("User has no spotify id");
    }
    // Refresh the token if it expires in less than two minutes (1000ms * 120)
    if (Date.now() > user.expiresIn - 1000 * 120) {
      const token = user.refreshToken;
      if (!token) {
        throw new Error("User has no refresh token");
      }
      const infos = await spotifyProvider.refresh(token);

      await storeInUser("_id", user._id, infos);
      logger.info(`Refreshed token for ${user.username}`);
      access = infos.accessToken;
    }
    if (access) {
      return spotifyProvider.getHttpClient(access);
    } else {
      throw new Error("Could not get any access token");
    }
  }

  public async raw(url: string) {
    const client = await this.checkToken();
    return client.get(url);
  }

  public async playTrack(trackUri: string) {
    const client = await this.checkToken();
    return client.put("/me/player/play", { data: { uris: [trackUri] } });
  }

  public async me() {
    const client = await this.checkToken();
    const res = await client.get("/me", { priority: "high" });
    return res.data as SpotifyMe;
  }

  public async playlists() {
    const items: SpotifyPlaylist[] = [];

    let nextUrl = "/me/playlists?limit=50";
    while (nextUrl) {
      const thisUrl = nextUrl;

      const client = await this.checkToken();
      const res = await client.get(thisUrl);
      nextUrl = res.data.next;
      items.push(...res.data.items);
    }
    return items;
  }

  private async handleAddIdsToPlaylist(id: string, ids: string[]) {
    const chunks = chunk(ids, 100);
    for (let i = 0; i < chunks.length; i += 1) {
      const chk = chunks[i]!;

      const client = await this.checkToken();
      await client.post(`/playlists/${id}/tracks`, {
        data: { uris: chk.map((trackId) => `spotify:track:${trackId}`) },
      });
    }
  }

  public async addToPlaylist(id: string, ids: string[]) {
    await this.checkToken();
    return this.handleAddIdsToPlaylist(id, ids);
  }

  public async createPlaylist(name: string, ids: string[]) {
    const client = await this.checkToken();
    const { data } = await client.post(`/me/playlists`, {
      data: { name, public: true, collaborative: false, description: "" },
    });
    return this.handleAddIdsToPlaylist(data.id, ids);
  }

  // 400 and 404 mean the item does not exist, anything else is a real failure
  private async getItem<T>(url: string) {
    const client = await this.checkToken();
    try {
      const res = await client.get(url);
      return res.data as T;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 404)) {
        return undefined;
      }
      throw e;
    }
  }

  getTrack(id: string) {
    return this.getItem<SpotifyTrack>(`/tracks/${id}`);
  }

  async getTracks(spotifyIds: string[]) {
    const tracks: (SpotifyTrack | undefined)[] = [];
    for (const id of spotifyIds) {
      const track = await this.getTrack(id);
      tracks.push(track);
    }
    return tracks;
  }

  getAlbum(id: string) {
    return this.getItem<SpotifyAlbum>(`/albums/${id}`);
  }

  async getAlbums(spotifyIds: string[]) {
    const albums: (SpotifyAlbum | undefined)[] = [];
    for (const id of spotifyIds) {
      const album = await this.getAlbum(id);
      albums.push(album);
    }
    return albums;
  }

  getArtist(id: string) {
    return this.getItem<SpotifyArtist>(`/artists/${id}`);
  }

  async getArtists(spotifyIds: string[]) {
    const artists: (SpotifyArtist | undefined)[] = [];
    for (const id of spotifyIds) {
      const artist = await this.getArtist(id);
      artists.push(artist);
    }
    return artists;
  }

  public async search(track: string, artist: string) {
    try {
      const client = await this.checkToken();
      const limitedTrack = track.slice(0, 100);
      const limitedArtist = artist.slice(0, 100);
      const res = await client.get(
        `/search?q=track:${encodeURIComponent(
          limitedTrack,
        )}+artist:${encodeURIComponent(limitedArtist)}&type=track&limit=10`,
      );
      return res.data.tracks.items[0] as SpotifyTrack;
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 404) {
          return undefined;
        }
      }
      throw e;
    }
  }
}
