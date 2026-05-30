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

  test("catalog contains the required demo tracks", () => {
    const ids = RADIO_TRACKS.map((track) => track.id).sort();

    expect(ids).toEqual(["buffer-bloom", "neon-postcard", "soft-launch"]);
  });

  test("every asset exists, matches its checksum, and uses the expected WAV format", async () => {
    for (const track of RADIO_TRACKS) {
      const bytes = await readFile(track.assetPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const dataByteLength = bytes.readUInt32LE(40);
      const byteRate = bytes.readUInt32LE(28);
      const blockAlign = bytes.readUInt16LE(32);
      const durationMs = (dataByteLength / byteRate) * 1000;

      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(22_050);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(dataByteLength % blockAlign).toBe(0);
      expect(durationMs).toBe(18_000);
      expect(track.durationMs).toBe(durationMs);
      expect(sha256).toBe(track.sha256);
    }
  });

  test("every license is repo-generated", () => {
    expect(
      RADIO_TRACKS.every((track) => track.license === "repo-generated"),
    ).toBe(true);
  });

  test("every audio path is assistant-runtime-relative", () => {
    for (const track of RADIO_TRACKS) {
      expect(track.audioPath.startsWith("radio/tracks/")).toBe(true);
      expect(track.audioPath.startsWith("/")).toBe(false);
    }
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
