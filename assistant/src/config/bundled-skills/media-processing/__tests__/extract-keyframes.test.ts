import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PreprocessManifest } from "../services/preprocess.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the subject import
// ---------------------------------------------------------------------------

let lastPreprocessOptions: Record<string, unknown> | undefined;
let mockManifest: PreprocessManifest;
let mockPreprocessError: Error | null = null;

mock.module("../services/preprocess.js", () => ({
  preprocessForAsset: async (
    _assetId: string,
    options: Record<string, unknown>,
  ) => {
    lastPreprocessOptions = options;
    if (mockPreprocessError) throw mockPreprocessError;
    return mockManifest;
  },
}));

mock.module("../../../../memory/media-store.js", () => ({
  getMediaAssetById: () => ({ filePath: "/tmp/videos/test.mp4" }),
  getKeyframesForAsset: () => [{ id: "kf-1" }, { id: "kf-2" }, { id: "kf-3" }],
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import { run } from "../tools/extract-keyframes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<PreprocessManifest> = {},
): PreprocessManifest {
  return {
    assetId: "asset-1",
    videoPath: "/tmp/videos/test.mp4",
    durationSeconds: 60,
    segments: [
      {
        id: "seg-001",
        startSeconds: 0,
        endSeconds: 15,
        framePaths: ["/tmp/frame-1.jpg"],
        frameTimestamps: [0],
      },
    ],
    deadTimeRanges: [],
    subjectRegistry: { groups: [] },
    sectionBoundaries: [],
    config: {
      intervalSeconds: 1,
      segmentDuration: 15,
      deadTimeThreshold: 0.02,
      shortEdge: 480,
    },
    ...overrides,
  };
}

function makeContext() {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian" as const,
    onOutput: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extract_keyframes tool", () => {
  beforeEach(() => {
    lastPreprocessOptions = undefined;
    mockPreprocessError = null;
    mockManifest = makeManifest();
  });

  test("returns error when asset_id is missing", async () => {
    const result = await run({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe("asset_id is required.");
  });

  test("passes include_audio through to preprocessForAsset", async () => {
    await run({ asset_id: "asset-1", include_audio: true }, makeContext());

    expect(lastPreprocessOptions?.includeAudio).toBe(true);
  });

  test("defaults include_audio to false when not provided", async () => {
    await run({ asset_id: "asset-1" }, makeContext());

    expect(lastPreprocessOptions?.includeAudio).toBe(false);
  });

  test("maps all numeric option fields from tool input", async () => {
    await run(
      {
        asset_id: "asset-1",
        interval_seconds: 2,
        segment_duration: 30,
        dead_time_threshold: 0.05,
        short_edge: 720,
      },
      makeContext(),
    );

    expect(lastPreprocessOptions?.intervalSeconds).toBe(2);
    expect(lastPreprocessOptions?.segmentDuration).toBe(30);
    expect(lastPreprocessOptions?.deadTimeThreshold).toBe(0.05);
    expect(lastPreprocessOptions?.shortEdge).toBe(720);
  });

  test("passes detect_dead_time and section_config through", async () => {
    await run(
      {
        asset_id: "asset-1",
        detect_dead_time: true,
        section_config: "/tmp/sections.json",
      },
      makeContext(),
    );

    expect(lastPreprocessOptions?.detectDeadTime).toBe(true);
    expect(lastPreprocessOptions?.sectionConfigPath).toBe("/tmp/sections.json");
  });

  test("does not pass transcriptionMode or openaiApiKey", async () => {
    await run(
      {
        asset_id: "asset-1",
        include_audio: true,
        transcription_mode: "api",
      },
      makeContext(),
    );

    expect(lastPreprocessOptions).toBeDefined();
    expect("transcriptionMode" in lastPreprocessOptions!).toBe(false);
    expect("openaiApiKey" in lastPreprocessOptions!).toBe(false);
  });

  test("returns successful result with manifest summary", async () => {
    const result = await run({ asset_id: "asset-1" }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.assetId).toBe("asset-1");
    expect(parsed.segmentCount).toBe(1);
    expect(parsed.keyframeCount).toBe(3);
  });

  test("returns error content for known preprocess failures", async () => {
    mockPreprocessError = new Error("Media asset not found: asset-bad");

    const result = await run({ asset_id: "asset-bad" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Media asset not found: asset-bad");
  });

  test("wraps unknown errors in generic message", async () => {
    mockPreprocessError = new Error("Something unexpected");

    const result = await run({ asset_id: "asset-1" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Preprocess failed: Something unexpected");
  });
});
