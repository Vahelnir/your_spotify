import mongoose from "mongoose";

import {
  addTrackIdsToUser,
  storeInUser,
  storeFirstListenedAtIfLess,
} from "../database";
import { TrackModel, AlbumModel, ArtistModel } from "../database/Models";
import { Album, SpotifyAlbum } from "../database/schemas/album";
import { Artist } from "../database/schemas/artist";
import { Infos } from "../database/schemas/info";
import { SpotifyTrack, Track } from "../database/schemas/track";
import { SpotifyAPI } from "../tools/apis/spotifyApi";
import { longWriteDbLock } from "../tools/lock";
import { logger } from "../tools/logger";
import { Metrics } from "../tools/metrics";
import { minOfArray, uniqBy } from "../tools/misc";
import { compact } from "../tools/utils";

const toTracks = (userId: string, spotifyTracks: SpotifyTrack[]) => {
  const tracks = spotifyTracks.map<Track>((track) => {
    logger.info(
      `Storing non existing track ${track.name} by ${track.artists[0]?.name}`,
    );
    return {
      ...track,
      album: track.album.id,
      artists: track.artists.map((e) => e.id),
    };
  });
  Metrics.ingestedTracksTotal.inc({ user: userId }, tracks.length);

  return tracks;
};

export const getTracks = async (userId: string, ids: string[]) => {
  const client = new SpotifyAPI(userId);
  return toTracks(userId, compact(await client.getTracks(ids)));
};

// Albums embedded in a track have no genres nor copyrights
const toAlbums = (userId: string, spotifyAlbums: SpotifyAlbum[]) => {
  const albums = spotifyAlbums.map<Album>((alb) => {
    logger.info(
      `Storing non existing album ${alb.name} by ${alb.artists[0]?.name}`,
    );

    return {
      ...alb,
      artists: alb.artists.map((art) => art.id),
      genres: alb.genres ?? [],
      copyrights: alb.copyrights ?? [],
    };
  });
  Metrics.ingestedAlbumsTotal.inc({ user: userId }, albums.length);

  return albums;
};

export const getAlbums = async (userId: string, ids: string[]) => {
  const client = new SpotifyAPI(userId);
  return toAlbums(userId, compact(await client.getAlbums(ids)));
};

export const getArtists = async (userId: string, ids: string[]) => {
  const client = new SpotifyAPI(userId);
  const spotifyArtists = compact(await client.getArtists(ids));

  for (const spotifyArtist of spotifyArtists) {
    logger.info(`Storing non existing artist ${spotifyArtist.name}`);
  }

  Metrics.ingestedArtistsTotal.inc({ user: userId }, spotifyArtists.length);

  return spotifyArtists;
};

export const getTracksAlbumsArtists = async (
  userId: string,
  spotifyTracks: SpotifyTrack[],
) => {
  const validTracks = uniqBy(
    spotifyTracks.filter((track) => track.id && !track.is_local),
    (track) => track.id,
  );
  const storedTracks: Track[] = await TrackModel.find({
    id: { $in: validTracks.map((track) => track.id) },
  });
  const storedTrackIds = new Set(storedTracks.map((t) => t.id.toString()));
  const missingTracks = validTracks.filter(
    (track) => !storedTrackIds.has(track.id.toString()),
  );

  if (missingTracks.length === 0) {
    logger.info("No missing tracks, passing...");
    return { tracks: [], albums: [], artists: [] };
  }

  const tracks = toTracks(userId, missingTracks);
  const relatedArtists = [...new Set(tracks.flatMap((e) => e.artists))];
  const relatedAlbums = [...new Set(tracks.map((e) => e.album))];

  const storedAlbums: Album[] = await AlbumModel.find({
    id: { $in: relatedAlbums },
  });
  const missingAlbumIds = relatedAlbums.filter(
    (alb) =>
      !storedAlbums.find((salb) => salb.id.toString() === alb.toString()),
  );

  const storedArtists: Artist[] = await ArtistModel.find({
    id: { $in: relatedArtists },
  });
  const missingArtistIds = relatedArtists.filter(
    (alb) =>
      !storedArtists.find((salb) => salb.id.toString() === alb.toString()),
  );

  // A track read from the database only has an album id: fetch those albums
  const missingAlbums = uniqBy(
    missingTracks
      .map((track) => track.album)
      .filter((alb) => missingAlbumIds.includes(alb.id)),
    (alb) => alb.id,
  );
  const fetchedAlbumIds = missingAlbums
    .filter((alb) => !alb.name)
    .map((alb) => alb.id);
  const albums = toAlbums(
    userId,
    missingAlbums.filter((alb) => alb.name),
  );
  if (fetchedAlbumIds.length > 0) {
    albums.push(...(await getAlbums(userId, fetchedAlbumIds)));
  }
  const artists =
    missingArtistIds.length > 0
      ? await getArtists(userId, missingArtistIds)
      : [];

  return { tracks, albums, artists };
};

export async function storeTrackAlbumArtist({
  tracks,
  albums,
  artists,
}: {
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
}) {
  if (tracks) {
    await TrackModel.create(uniqBy(tracks, (item) => item.id));
  }
  if (albums) {
    await AlbumModel.create(uniqBy(albums, (item) => item.id));
  }
  if (artists) {
    await ArtistModel.create(uniqBy(artists, (item) => item.id));
  }
}

export async function storeIterationOfLoop(
  userId: string,
  iterationTimestamp: number,
  tracks: Track[],
  albums: Album[],
  artists: Artist[],
  infos: Omit<Infos, "owner">[],
) {
  await longWriteDbLock.lock();

  await storeTrackAlbumArtist({ tracks, albums, artists });

  await addTrackIdsToUser(userId, infos);

  await storeInUser("_id", new mongoose.Types.ObjectId(userId), {
    lastTimestamp: iterationTimestamp,
  });

  const min = minOfArray(infos, (item) => item.played_at.getTime());

  if (min) {
    const minInfo = infos[min.minIndex]?.played_at;
    if (minInfo) {
      await storeFirstListenedAtIfLess(userId, minInfo);
    }
  }

  longWriteDbLock.unlock();
}
