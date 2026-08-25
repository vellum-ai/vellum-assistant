import { describe, expect, test } from "bun:test";

import {
  isOnPath,
  PcmPlayer,
  wrapPcmAsWav,
  type PlayerCommand,
} from "./pcm-player.js";

describe("wrapPcmAsWav", () => {
  test("writes a canonical 44-byte mono PCM16 header for the given rate", () => {
    const pcm = Buffer.alloc(160, 7);
    const wav = wrapPcmAsWav(pcm, 24000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate = rate * 2
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  test("tracks the sample rate the frame declared, not a fixed one", () => {
    expect(wrapPcmAsWav(Buffer.alloc(2), 16000).readUInt32LE(24)).toBe(16000);
    expect(wrapPcmAsWav(Buffer.alloc(2), 44100).readUInt32LE(24)).toBe(44100);
  });
});

describe("PcmPlayer playback lifetime", () => {
  /** A player process whose lifetime a test controls. */
  const sleeper = (seconds: number): PlayerCommand => ({
    mode: "streaming",
    name: "/bin/sh",
    args: () => ["-c", `sleep ${seconds}`],
  });

  test("finish() waits for the player to exit, not for the last byte", async () => {
    const player = new PcmPlayer(sleeper(0.4));
    player.write(Buffer.alloc(64), 24000);
    expect(player.isPlaying).toBe(true);

    const started = performance.now();
    await player.finish();
    const elapsed = performance.now() - started;

    // Handing the prompt back at the last byte would resolve immediately; the
    // point of the await is that the speaker has actually gone quiet.
    expect(elapsed).toBeGreaterThan(250);
    expect(player.isPlaying).toBe(false);
    player.dispose();
  });

  test("stop() cuts playback off and releases a pending finish()", async () => {
    const player = new PcmPlayer(sleeper(5));
    player.write(Buffer.alloc(64), 24000);

    const started = performance.now();
    const pending = player.finish();
    player.stop();
    await pending;

    // A finish() that outlived its interrupt would wedge the prompt for the
    // rest of the session, which is exactly the barge-in case.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(player.isPlaying).toBe(false);
    player.dispose();
  });

  test("finish() resolves immediately when there is no player", async () => {
    const player = new PcmPlayer(null);
    player.write(Buffer.alloc(64), 24000);
    await player.finish();
    expect(player.mode).toBe("silent");
  });

  test("a player that cannot be spawned does not wedge finish()", async () => {
    const missing: PlayerCommand = {
      mode: "streaming",
      name: "definitely-not-a-real-player-binary",
      args: () => [],
    };
    const player = new PcmPlayer(missing);
    player.write(Buffer.alloc(64), 24000);
    await player.finish();
    expect(player.isPlaying).toBe(false);
    player.dispose();
  });
});

describe("isOnPath", () => {
  test("finds a binary that exists and rejects one that does not", () => {
    expect(isOnPath("sh")).toBe(true);
    expect(isOnPath("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
