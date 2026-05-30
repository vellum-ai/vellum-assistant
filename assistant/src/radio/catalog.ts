import { join } from "node:path";

import { resolveBundledDir } from "../util/bundled-asset.js";
import type { RadioTrack } from "./types.js";

const assetsDir = resolveBundledDir(
  import.meta.dirname ?? __dirname,
  "./assets",
  "radio-assets",
);

const tracks = [
  {
    id: "soft-launch",
    title: "Soft Launch",
    artist: "Vellum Demo Ensemble",
    durationMs: 18_000,
    assetPath: join(assetsDir, "soft-launch.wav"),
    audioPath: "radio/tracks/soft-launch",
    sourceLabel: "Generated demo track",
    license: "repo-generated",
    sha256: "879a8f05b17391f77678b818b1f438de93ed5350148f0cf4bda7899995ecc74d",
  },
  {
    id: "buffer-bloom",
    title: "Buffer Bloom",
    artist: "Vellum Demo Ensemble",
    durationMs: 18_000,
    assetPath: join(assetsDir, "buffer-bloom.wav"),
    audioPath: "radio/tracks/buffer-bloom",
    sourceLabel: "Generated demo track",
    license: "repo-generated",
    sha256: "92fb043b22b77eefe682afa776e0d23f6b690ce7de011aadf9327a099dac27cc",
  },
  {
    id: "neon-postcard",
    title: "Neon Postcard",
    artist: "Vellum Demo Ensemble",
    durationMs: 18_000,
    assetPath: join(assetsDir, "neon-postcard.wav"),
    audioPath: "radio/tracks/neon-postcard",
    sourceLabel: "Generated demo track",
    license: "repo-generated",
    sha256: "7a56f7c6c1c6e4750c90542dd261da56d11e0a02e8942d687061febd9fdbdca0",
  },
] satisfies RadioTrack[];

export const RADIO_TRACKS = Object.freeze(
  tracks.map((track) => Object.freeze(track)),
);

export function listRadioTracks(): readonly RadioTrack[] {
  return RADIO_TRACKS;
}

export function getRadioTrack(id: string): RadioTrack | undefined {
  return RADIO_TRACKS.find((track) => track.id === id);
}

export function pickFallbackTrack({
  currentTrackId,
  recentTrackIds = [],
}: {
  currentTrackId?: string;
  recentTrackIds?: readonly string[];
}): RadioTrack {
  const nonCurrentTracks = currentTrackId
    ? RADIO_TRACKS.filter((track) => track.id !== currentTrackId)
    : RADIO_TRACKS;
  const candidateTracks =
    nonCurrentTracks.length > 0 ? nonCurrentTracks : RADIO_TRACKS;
  const recentTrackIdSet = new Set(recentTrackIds);
  const notRecentTracks = candidateTracks.filter(
    (track) => !recentTrackIdSet.has(track.id),
  );

  return (notRecentTracks[0] ?? candidateTracks[0])!;
}
