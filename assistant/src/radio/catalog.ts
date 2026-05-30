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
    sha256: "9b1fae4baae9f2cf47e4a8a5d626daf5553f31c9bcf8269085be41efaacae7a9",
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
    sha256: "0abd0ef29d2cd809415857af7419527c1f22781e91254e43661cb7540b122f70",
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
    sha256: "bc5aba81f50d306f96fc9326a14be5686602faa4b8792f68663a499bf4a0f28c",
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
