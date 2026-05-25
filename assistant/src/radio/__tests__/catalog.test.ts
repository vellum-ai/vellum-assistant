import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

import {
  getRadioTrack,
  listRadioTracks,
  pickFallbackTrack,
  RADIO_TRACKS,
} from "../catalog.js";

describe("radio catalog", () => {
  test("track ids are unique", () => {
    const ids = RADIO_TRACKS.map((track) => track.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every asset exists and matches its checksum", async () => {
    for (const track of RADIO_TRACKS) {
      const bytes = await readFile(track.assetPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      expect(sha256).toBe(track.sha256);
    }
  });

  test("every license is repo-generated", () => {
    expect(
      RADIO_TRACKS.every((track) => track.license === "repo-generated"),
    ).toBe(true);
  });

  test("catalog helpers expose tracks by id", () => {
    const tracks = listRadioTracks();

    expect(tracks).toEqual(RADIO_TRACKS);
    expect(getRadioTrack(tracks[0]!.id)).toEqual(tracks[0]);
    expect(getRadioTrack("missing-track")).toBeUndefined();
  });

  test("fallback never picks the current track when alternatives exist", () => {
    const [current, ...alternatives] = RADIO_TRACKS;

    expect(alternatives.length).toBeGreaterThan(0);

    for (const recentTrackIds of [
      [],
      alternatives.map((track) => track.id),
      RADIO_TRACKS.map((track) => track.id),
    ]) {
      const fallback = pickFallbackTrack({
        currentTrackId: current!.id,
        recentTrackIds,
      });

      expect(fallback.id).not.toBe(current!.id);
    }
  });
});
