import { readFile, unlink } from "fs/promises";

import { z } from "zod";

import {
  addTrackIdsToUser,
  getCloseTrackId,
  storeFirstListenedAtIfLess,
} from "../../database";
import { TrackModel } from "../../database/Models";
import { setImporterStateCurrent } from "../../database/queries/importer";
import { Infos } from "../../database/schemas/info";
import {
  RecentlyPlayedTrack,
  SpotifyTrack,
} from "../../database/schemas/track";
import { User } from "../../database/schemas/user";
import {
  getTracksAlbumsArtists,
  storeTrackAlbumArtist,
} from "../../spotify/dbTools";
import { isTransientError } from "../apis/queueHttpClient";
import { SpotifyAPI } from "../apis/spotifyApi";
import { logger } from "../logger";
import { minOfArray, retryPromise } from "../misc";
import { Unpack } from "../types";
import { getFromCacheString, setToCacheString } from "./cache";
import { FullPrivacyImporterState, HistoryImporter } from "./types";

const fullPrivacyFileSchema = z.array(
  z.object({
    ts: z.string(),
    ms_played: z.number(),
    spotify_track_uri: z.string().nullable(),
    master_metadata_track_name: z.string().nullable(),
    master_metadata_album_artist_name: z.string().nullable(),
  }),
);

export type FullPrivacyItem = Unpack<z.infer<typeof fullPrivacyFileSchema>>;

export class FullPrivacyImporter implements HistoryImporter<"full-privacy"> {
  private id: string;

  private userId: string;

  private elements: FullPrivacyItem[] | null;

  private currentItem: number;

  private spotifyApi: SpotifyAPI;

  constructor(user: User) {
    this.id = "";
    this.userId = user._id.toString();
    this.elements = null;
    this.currentItem = 0;
    this.spotifyApi = new SpotifyAPI(this.userId);
  }

  static idFromSpotifyURI = (uri: string) => uri.split(":")[2];

  getTrackFromDb = async (id: string) => {
    const track = await TrackModel.findOne({ id }, { _id: 0, __v: 0 }).lean();
    if (!track) {
      return undefined;
    }
    return {
      ...track,
      album: { id: track.album },
      artists: track.artists.map((artistId) => ({ id: artistId })),
    } as unknown as SpotifyTrack;
  };

  getTrack = async (id: string) => {
    const userId = this.userId.toString();
    const cached = getFromCacheString(userId, id);
    if (cached) {
      return cached.exists ? cached.track : undefined;
    }
    const track =
      (await this.getTrackFromDb(id)) ??
      (await retryPromise(
        () => this.spotifyApi.getTrack(id),
        3,
        30,
        isTransientError,
      ));
    setToCacheString(
      userId,
      id,
      track ? { exists: true, track } : { exists: false },
    );
    return track;
  };

  storeItems = async (userId: string, items: RecentlyPlayedTrack[]) => {
    const { tracks, albums, artists } = await getTracksAlbumsArtists(
      userId,
      items.map((it) => it.track),
    );
    await storeTrackAlbumArtist({ tracks, albums, artists });
    const finalInfos: Omit<Infos, "owner">[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const date = new Date(item.played_at);
      const duplicate = await getCloseTrackId(
        this.userId.toString(),
        item.track.id,
        date,
        60,
      );
      const currentImportDuplicate = finalInfos.find(
        (e) => Math.abs(e.played_at.getTime() - date.getTime()) <= 60 * 1000,
      );
      if (duplicate.length > 0 || currentImportDuplicate) {
        logger.info(
          `${item.track.name} - ${item.track.artists[0]?.name} was duplicate`,
        );
        continue;
      }
      const [primaryArtist] = item.track.artists;
      if (!primaryArtist) {
        continue;
      }
      finalInfos.push({
        played_at: date,
        id: item.track.id,
        primaryArtistId: primaryArtist.id,
        albumId: item.track.album.id,
        artistIds: item.track.artists.map((e) => e.id),
        durationMs: item.track.duration_ms,
      });
    }
    await addTrackIdsToUser(this.userId.toString(), finalInfos);
    await setImporterStateCurrent(this.id, this.currentItem + 1);
    const min = minOfArray(finalInfos, (info) => info.played_at.getTime());
    if (min) {
      const minInfo = finalInfos[min.minIndex];
      if (minInfo) {
        await storeFirstListenedAtIfLess(this.userId, minInfo.played_at);
      }
    }
  };

  initWithJSONContent = async (content: any[]) => {
    const value = fullPrivacyFileSchema.safeParse(content);
    if (value.success) {
      this.elements = value.data;
      return content;
    }
    logger.error(
      "If you submitted the right files and this error comes up, please open an issue with the following logs at https://github.com/Yooooomi/your_spotify",
      JSON.stringify(value.error.issues, null, " "),
    );
    return null;
  };

  initWithFiles = async (filePaths: string[]) => {
    const files = await Promise.all(filePaths.map((f) => readFile(f)));
    const filesContent = files.map((f) => JSON.parse(f.toString()));

    const totalContent = filesContent.reduce<FullPrivacyItem[]>((acc, curr) => {
      acc.push(...curr);
      return acc;
    }, []);

    if (!(await this.initWithJSONContent(totalContent))) {
      return false;
    }

    return true;
  };

  init = async (
    existingState: FullPrivacyImporterState | null,
    filePaths: string[],
  ) => {
    try {
      this.currentItem = existingState?.current ?? 0;
      const success = await this.initWithFiles(filePaths);
      if (success) {
        return { total: this.elements!.length };
      }
    } catch (e) {
      logger.error(e);
    }
    return null;
  };

  run = async (id: string) => {
    this.id = id;
    let items: RecentlyPlayedTrack[] = [];
    if (!this.elements) {
      return false;
    }
    for (let i = this.currentItem; i < this.elements.length; i += 1) {
      this.currentItem = i;
      logger.info(`Importing... (${i}/${this.elements.length})`);
      const content = this.elements[i]!;
      if (
        !content.spotify_track_uri ||
        !content.master_metadata_track_name ||
        !content.master_metadata_album_artist_name
      ) {
        continue;
      }
      if (content.ms_played < 30 * 1000) {
        // If track was played for less than 30 seconds
        logger.info(
          `Track ${content.master_metadata_track_name} - ${
            content.master_metadata_album_artist_name
          } was passed, only listened for ${Math.floor(
            content.ms_played / 1000,
          )} seconds`,
        );
        continue;
      }
      if (!content.spotify_track_uri.startsWith("spotify:track:")) {
        logger.debug(`Not a track uri: ${content.spotify_track_uri}`);
      }
      const spotifyId = FullPrivacyImporter.idFromSpotifyURI(
        content.spotify_track_uri,
      );
      if (!spotifyId) {
        logger.warn(
          `Could not get spotify id from uri: ${content.spotify_track_uri}`,
        );
        continue;
      }
      const track = await this.getTrack(spotifyId);
      if (track) {
        items.push({ track, played_at: content.ts });
      }
      if (items.length >= 20) {
        await this.storeItems(this.userId, items);
        items = [];
      }
    }
    if (items.length > 0) {
      await this.storeItems(this.userId, items);
      items = [];
    }
    return true;
  };

  cleanup = async (filePaths: string[]) => {
    await Promise.all(filePaths.map((f) => unlink(f)));
  };
}
