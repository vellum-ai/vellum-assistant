import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "memory-observation-dual-write-test-"),
);
const dbPath = join(testDir, "test.db");

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => join(testDir, ".vellum"),
  getWorkspaceDir: () => join(testDir, ".vellum", "workspace"),
  getConversationsDir: () =>
    join(testDir, ".vellum", "workspace", "conversations"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => dbPath,
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub the local embedding backend so the real ONNX model never loads.
mock.module("../memory/embedding-local.js", () => ({
  LocalEmbeddingBackend: class {
    readonly provider = "local" as const;
    readonly model: string;
    constructor(model: string) {
      this.model = model;
    }
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(384).fill(0));
    }
  },
}));

// Mock Qdrant client so semantic search returns empty results.
mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";

// Enable memory but disable LLM extraction and summarization.
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
    summarization: {
      ...DEFAULT_CONFIG.memory.summarization,
      useLLM: false,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

import { eq } from "drizzle-orm";

import { getChunkByObservationId } from "../memory/archive-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, rawAll, resetDb } from "../memory/db.js";
import { memoryObservations, memorySegments } from "../memory/schema.js";

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function getObservationsByConversation(conversationId: string) {
  const db = getDb();
  return db
    .select()
    .from(memoryObservations)
    .where(eq(memoryObservations.conversationId, conversationId))
    .all();
}

function getJobsByType(type: string) {
  return rawAll<{
    id: string;
    type: string;
    payload: string;
    status: string;
  }>(`SELECT id, type, payload, status FROM memory_jobs WHERE type = ?`, type);
}

// ── Setup ───────────────────────────────────────────────────────────

describe("memory observation dual-write from addMessage", () => {
  beforeEach(() => {
    resetDb();
    removeTestDbFiles();
    initializeDb();
  });

  afterEach(() => {
    resetDb();
    removeTestDbFiles();
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── Text-only messages ──────────────────────────────────────────

  describe("text-only messages", () => {
    test("creates an observation for a plain text user message", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "I prefer dark mode for all editors");

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      expect(observations[0].role).toBe("user");
      expect(observations[0].content).toBe(
        "I prefer dark mode for all editors",
      );
      expect(observations[0].modality).toBe("text");
      expect(observations[0].scopeId).toBe("default");
    });

    test("creates an observation for an assistant message", async () => {
      const conv = createConversation("test-conv");
      await addMessage(
        conv.id,
        "assistant",
        "Sure, I will use dark mode from now on.",
      );

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      expect(observations[0].role).toBe("assistant");
      expect(observations[0].content).toBe(
        "Sure, I will use dark mode from now on.",
      );
    });

    test("creates a chunk with embed_chunk job for text message", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "My favorite language is TypeScript");

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);

      const chunk = getChunkByObservationId(observations[0].id);
      expect(chunk).toBeDefined();
      expect(chunk!.content).toBe("My favorite language is TypeScript");

      const embedJobs = getJobsByType("embed_chunk");
      expect(embedJobs.length).toBeGreaterThanOrEqual(1);
      const matchingJob = embedJobs.find((j) => {
        const payload = JSON.parse(j.payload);
        return payload.chunkId === chunk!.id;
      });
      expect(matchingJob).toBeDefined();
    });

    test("links observation to the correct messageId", async () => {
      const conv = createConversation("test-conv");
      const msg = await addMessage(conv.id, "user", "Testing message link");

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      expect(observations[0].messageId).toBe(msg.id);
    });

    test("uses conversation memory scope for observation", async () => {
      const conv = createConversation({
        conversationType: "private",
      });
      await addMessage(conv.id, "user", "Private observation");

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      expect(observations[0].scopeId).toBe(`private:${conv.id}`);
    });
  });

  // ── Multimodal messages ─────────────────────────────────────────

  describe("multimodal messages", () => {
    test("creates observation for message with text + image blocks", async () => {
      const conv = createConversation("test-conv");
      const content = JSON.stringify([
        { type: "text", text: "Here is my screenshot" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ]);
      await addMessage(conv.id, "user", content);

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      // Text extraction produces the text portion
      expect(observations[0].content).toContain("Here is my screenshot");
      // Text+image = multimodal since media blocks are present
      expect(observations[0].modality).toBe("multimodal");
    });

    test("creates observation with multimodal modality for image-only message", async () => {
      const conv = createConversation("test-conv");
      const content = JSON.stringify([
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ]);
      await addMessage(conv.id, "user", content);

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
      expect(observations[0].modality).toBe("multimodal");
    });
  });

  // ── Legacy indexing unchanged ───────────────────────────────────

  describe("legacy indexing continues alongside dual-write", () => {
    test("legacy memory_segments are still created for text messages", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "A fact worth remembering for memory");

      // Legacy segments should exist
      const db = getDb();
      const segments = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.conversationId, conv.id))
        .all();
      expect(segments.length).toBeGreaterThanOrEqual(1);

      // Observation should also exist
      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(1);
    });

    test("legacy extract_items jobs are still enqueued for user messages", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "The user lives in San Francisco");

      const extractJobs = getJobsByType("extract_items");
      expect(extractJobs.length).toBeGreaterThanOrEqual(1);
    });

    test("skipping indexing skips both legacy and observation writes", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "No indexing please", undefined, {
        skipIndexing: true,
      });

      // No legacy segments
      const db = getDb();
      const segments = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.conversationId, conv.id))
        .all();
      expect(segments).toHaveLength(0);

      // No observations
      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(0);
    });

    test("does not create observation for empty content messages", async () => {
      const conv = createConversation("test-conv");
      await addMessage(conv.id, "user", "");

      const observations = getObservationsByConversation(conv.id);
      expect(observations).toHaveLength(0);
    });
  });
});
