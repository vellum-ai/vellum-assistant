import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the subject import
// ---------------------------------------------------------------------------

let mockTranscribeResult: string = "";

mock.module("../services/audio-transcribe.js", () => ({
  transcribeSegmentAudio: async () => mockTranscribeResult,
}));

let spawnExitCode = 0;

mock.module("../../../../util/spawn.js", () => ({
  spawnWithTimeout: async () => ({
    exitCode: spawnExitCode,
    stdout: "",
    stderr: "",
  }),
  FFMPEG_PALETTE_TIMEOUT_MS: 10_000,
  FFMPEG_PREPROCESS_TIMEOUT_MS: 60_000,
}));

mock.module("../../../../memory/media-store.js", () => ({
  getMediaAssetById: (id: string) => ({
    id,
    mediaType: "video",
    filePath: "/tmp/videos/test.mp4",
    durationSeconds: 30,
  }),
  getProcessingStagesForAsset: () => [],
  createProcessingStage: () => ({ id: "stage-1" }),
  updateProcessingStage: () => {},
  deleteKeyframesForAsset: () => {},
  insertKeyframesBatch: () => {},
}));

// Mock fs — readdir must return frame filenames to produce segments with frames
let mockReaddirFiles: string[] = ["frame-000001.jpg", "frame-000002.jpg"];

mock.module("node:fs/promises", () => ({
  mkdir: async () => {},
  readdir: async () => mockReaddirFiles,
  readFile: async () => "[]",
  rename: async () => {},
  rm: async () => {},
  writeFile: async () => {},
}));

mock.module("../../../../util/silently.js", () => ({
  silentlyWithLog: async () => {},
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import { preprocessForAsset } from "../services/preprocess.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preprocessForAsset — audio transcript enrichment", () => {
  beforeEach(() => {
    mockTranscribeResult = "";
    spawnExitCode = 0;
    mockReaddirFiles = ["frame-000001.jpg", "frame-000002.jpg"];
  });

  test("attaches transcript to segments when transcription returns text", async () => {
    mockTranscribeResult = "Hello world, this is a transcript.";

    const manifest = await preprocessForAsset("asset-1", {
      includeAudio: true,
      segmentDuration: 30,
    });

    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      expect(seg.transcript).toBe("Hello world, this is a transcript.");
    }
  });

  test("omits transcript field when transcription returns empty string", async () => {
    mockTranscribeResult = "";

    const manifest = await preprocessForAsset("asset-1", {
      includeAudio: true,
      segmentDuration: 30,
    });

    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      expect(seg.transcript).toBeUndefined();
    }
  });

  test("does not set transcript when includeAudio is false", async () => {
    mockTranscribeResult = "Should not appear";

    const manifest = await preprocessForAsset("asset-1", {
      includeAudio: false,
      segmentDuration: 30,
    });

    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      expect(seg.transcript).toBeUndefined();
    }
  });

  test("does not set transcript when includeAudio is omitted", async () => {
    mockTranscribeResult = "Should not appear";

    const manifest = await preprocessForAsset("asset-1", {
      segmentDuration: 30,
    });

    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      expect(seg.transcript).toBeUndefined();
    }
  });

  test("does not throw when transcription returns empty for all segments", async () => {
    mockTranscribeResult = "";

    const manifest = await preprocessForAsset("asset-1", {
      includeAudio: true,
      segmentDuration: 15,
    });

    // Should complete successfully with segments but no transcripts
    expect(manifest.segments.length).toBeGreaterThan(0);
    expect(manifest.segments.every((s) => s.transcript === undefined)).toBe(
      true,
    );
  });
});
