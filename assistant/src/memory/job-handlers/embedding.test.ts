import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track calls to embedAndUpsert
const embedAndUpsertCalls: Array<{
  config: unknown;
  targetType: string;
  targetId: string;
  input: unknown;
  extraPayload: unknown;
}> = [];

mock.module("../job-utils.js", () => ({
  asString: (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null,
  embedAndUpsert: async (
    config: unknown,
    targetType: string,
    targetId: string,
    input: unknown,
    extraPayload: unknown,
  ) => {
    embedAndUpsertCalls.push({
      config,
      targetType,
      targetId,
      input,
      extraPayload,
    });
  },
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";
import { getDb, initializeDb, resetDb } from "../db.js";
import type { MemoryJob } from "../jobs-store.js";
import { mediaAssets } from "../schema.js";
import { embedMediaJob } from "./embedding.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

describe("embedMediaJob", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedAndUpsertCalls.length = 0;
    resetDb();
    initializeDb();
  });

  function makeJob(payload: Record<string, unknown>): MemoryJob {
    return {
      id: "job-1",
      type: "embed_media",
      payload,
      status: "running",
      attempts: 0,
      deferrals: 0,
      runAfter: 0,
      lastError: null,
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  test("skips when assetId is missing", async () => {
    await embedMediaJob(makeJob({}), TEST_CONFIG);
    expect(embedAndUpsertCalls).toHaveLength(0);
  });

  test("skips when asset is not found", async () => {
    await embedMediaJob(makeJob({ assetId: "nonexistent" }), TEST_CONFIG);
    expect(embedAndUpsertCalls).toHaveLength(0);
  });

  test("skips when asset status is not indexed", async () => {
    const db = getDb();
    const now = Date.now();
    // Create a temp file
    const filePath = join(testDir, "test-registered.png");
    writeFileSync(filePath, Buffer.from("fake image data"));

    db.insert(mediaAssets)
      .values({
        id: "asset-registered",
        title: "Test Image",
        filePath,
        mimeType: "image/png",
        durationSeconds: null,
        fileHash: "hash-registered",
        status: "registered",
        mediaType: "image",
        metadata: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await embedMediaJob(makeJob({ assetId: "asset-registered" }), TEST_CONFIG);
    expect(embedAndUpsertCalls).toHaveLength(0);
  });

  test("embeds indexed image asset with correct input type and target", async () => {
    const db = getDb();
    const now = Date.now();
    const filePath = join(testDir, "test-image.png");
    const imageData = Buffer.from("fake png data");
    writeFileSync(filePath, imageData);

    db.insert(mediaAssets)
      .values({
        id: "asset-image",
        title: "My Screenshot",
        filePath,
        mimeType: "image/png",
        durationSeconds: null,
        fileHash: "hash-image",
        status: "indexed",
        mediaType: "image",
        metadata: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await embedMediaJob(makeJob({ assetId: "asset-image" }), TEST_CONFIG);

    expect(embedAndUpsertCalls).toHaveLength(1);
    const call = embedAndUpsertCalls[0];
    expect(call.targetType).toBe("media");
    expect(call.targetId).toBe("asset-image");
    expect(call.input).toEqual({
      type: "image",
      data: imageData,
      mimeType: "image/png",
    });
    expect(call.extraPayload).toEqual({
      created_at: now,
      kind: "image",
      memory_scope_id: "default",
      subject: "My Screenshot",
    });
  });

  test("embeds indexed audio asset with correct modality", async () => {
    const db = getDb();
    const now = Date.now();
    const filePath = join(testDir, "test-audio.mp3");
    const audioData = Buffer.from("fake mp3 data");
    writeFileSync(filePath, audioData);

    db.insert(mediaAssets)
      .values({
        id: "asset-audio",
        title: "Podcast Episode",
        filePath,
        mimeType: "audio/mp3",
        durationSeconds: 120,
        fileHash: "hash-audio",
        status: "indexed",
        mediaType: "audio",
        metadata: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await embedMediaJob(makeJob({ assetId: "asset-audio" }), TEST_CONFIG);

    expect(embedAndUpsertCalls).toHaveLength(1);
    const call = embedAndUpsertCalls[0];
    expect(call.targetType).toBe("media");
    expect(call.targetId).toBe("asset-audio");
    expect((call.input as { type: string }).type).toBe("audio");
    expect((call.input as { mimeType: string }).mimeType).toBe("audio/mp3");
  });

  test("embeds indexed video asset with correct modality", async () => {
    const db = getDb();
    const now = Date.now();
    const filePath = join(testDir, "test-video.mp4");
    const videoData = Buffer.from("fake mp4 data");
    writeFileSync(filePath, videoData);

    db.insert(mediaAssets)
      .values({
        id: "asset-video",
        title: "Tutorial Video",
        filePath,
        mimeType: "video/mp4",
        durationSeconds: 300,
        fileHash: "hash-video",
        status: "indexed",
        mediaType: "video",
        metadata: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await embedMediaJob(makeJob({ assetId: "asset-video" }), TEST_CONFIG);

    expect(embedAndUpsertCalls).toHaveLength(1);
    const call = embedAndUpsertCalls[0];
    expect(call.targetType).toBe("media");
    expect(call.targetId).toBe("asset-video");
    expect((call.input as { type: string }).type).toBe("video");
    expect((call.input as { mimeType: string }).mimeType).toBe("video/mp4");
  });
});
