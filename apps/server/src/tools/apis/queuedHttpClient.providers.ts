import { getWithDefault } from "../env";
import { QueuedHttpClientFactory } from "./queueHttpClient";

export const spotifyHttpClientFactory = new QueuedHttpClientFactory({
  baseURL: "https://api.spotify.com/v1",
  headers: { "Content-Type": "application/json" },
  minApiIntervalMs: getWithDefault("SPOTIFY_MIN_REQUEST_INTERVAL_MS", 500),
});

export const githubHttpClientFactory = new QueuedHttpClientFactory({
  baseURL: "https://api.github.com",
  headers: { "Content-Type": "application/json" },
});
