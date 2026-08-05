import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @google/genai module: must be before importing the services
// ---------------------------------------------------------------------------

let capturedModels: string[] = [];

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(_opts: Record<string, unknown>) {}
    models = {
      generateContent: async (params: { model: string }) => {
        capturedModels.push(params.model);
        return {
          text: '{"frames":[]}',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          modelVersion: params.model,
        };
      },
    };
    files = {
      upload: async (_params: Record<string, unknown>) => ({
        name: "files/test-upload",
        uri: "https://example.com/files/test-upload",
        mimeType: "video/mp4",
      }),
      get: async (_params: Record<string, unknown>) => ({ state: "ACTIVE" }),
      delete: async (_params: Record<string, unknown>) => ({}),
    };
  },
  ApiError: class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Import after mocking
import { resolveModelIntent } from "../../../../providers/model-intents.js";
import { mapSegments } from "../services/gemini-map.js";
import { analyzeVideoDirectly } from "../services/gemini-video.js";
import { resolveMediaAnalysisModel } from "../services/media-analysis-model.js";
import type { Segment } from "../services/preprocess.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPECTED_DEFAULT = resolveModelIntent("gemini", "vision-optimized");

const OUTPUT_SCHEMA = { type: "object", properties: {} };

async function createPipelineDir(): Promise<{
  pipelineDir: string;
  segments: Segment[];
}> {
  const pipelineDir = await mkdtemp(join(tmpdir(), "media-model-test-"));
  const framePath = join(pipelineDir, "frame-000.jpg");
  await writeFile(framePath, Buffer.from("fake-jpeg-bytes"));
  const segments: Segment[] = [
    {
      id: "seg-000",
      startSeconds: 0,
      endSeconds: 10,
      framePaths: [framePath],
      frameTimestamps: [0],
    },
  ];
  return { pipelineDir, segments };
}

function mapOptions(model?: string) {
  return {
    apiKey: "test-key",
    systemPrompt: "Describe the frames.",
    outputSchema: OUTPUT_SCHEMA,
    model,
  };
}

beforeEach(() => {
  capturedModels = [];
});

// ---------------------------------------------------------------------------
// Automatic no-override path (the background media-processing job passes no
// model, so the services' default is what runs in production)
// ---------------------------------------------------------------------------

describe("media analysis default model (no-override path)", () => {
  test("resolveMediaAnalysisModel defaults to the vision-optimized catalog intent", () => {
    expect(resolveMediaAnalysisModel(undefined)).toBe(EXPECTED_DEFAULT);
    // Regression (LUM-3038): the default must not be the retired pinned model.
    expect(resolveMediaAnalysisModel(undefined)).not.toBe("gemini-2.5-flash");
    expect(resolveMediaAnalysisModel("custom-model")).toBe("custom-model");
  });

  test("keyframe mapping without a model override executes the resolved default", async () => {
    const { pipelineDir, segments } = await createPipelineDir();

    const output = await mapSegments(
      "asset-1",
      pipelineDir,
      segments,
      mapOptions(),
    );

    expect(capturedModels).toEqual([EXPECTED_DEFAULT]);
    expect(output.model).toBe(EXPECTED_DEFAULT);
    expect(output.successCount).toBe(1);
  });

  test("cache identity agrees with the execution default", async () => {
    const { pipelineDir, segments } = await createPipelineDir();

    await mapSegments("asset-1", pipelineDir, segments, mapOptions());
    expect(capturedModels).toHaveLength(1);

    // A rerun that pins the same model the default resolved to must hit the
    // per-segment cache: the config hash and the executed model agree.
    const rerun = await mapSegments(
      "asset-1",
      pipelineDir,
      segments,
      mapOptions(EXPECTED_DEFAULT),
    );
    expect(capturedModels).toHaveLength(1);
    expect(rerun.successCount).toBe(1);

    // A different model must miss the cache (hash covers the model).
    await mapSegments(
      "asset-1",
      pipelineDir,
      segments,
      mapOptions("custom-model"),
    );
    expect(capturedModels).toEqual([EXPECTED_DEFAULT, "custom-model"]);
  });

  test("direct video analysis without a model override executes the resolved default", async () => {
    const { pipelineDir } = await createPipelineDir();
    const videoPath = join(pipelineDir, "video.mp4");
    await writeFile(videoPath, Buffer.from("fake-mp4-bytes"));

    const output = await analyzeVideoDirectly(
      "asset-1",
      pipelineDir,
      mapOptions(),
      videoPath,
      12,
      "video/mp4",
    );

    expect(capturedModels).toEqual([EXPECTED_DEFAULT]);
    expect(output.model).toBe(EXPECTED_DEFAULT);
  });

  test("an explicit model override wins over the default", async () => {
    const { pipelineDir, segments } = await createPipelineDir();

    const output = await mapSegments(
      "asset-1",
      pipelineDir,
      segments,
      mapOptions("gemini-explicit-override"),
    );

    expect(capturedModels).toEqual(["gemini-explicit-override"]);
    expect(output.model).toBe("gemini-explicit-override");
  });
});
