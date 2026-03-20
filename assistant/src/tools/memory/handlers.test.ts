/**
 * Tests for memory tool handlers (simplified-memory only).
 *
 * Covers:
 * - memory_save: input validation, happy path via simplified observation store
 * - memory_recall: input validation, empty results, result shape, error handling
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "memory-tool-handler-"));

// ── Module mocks (must precede production imports) ───────────────────

mock.module("../../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../memory/embedding-local.js", () => ({
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

mock.module("../../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
    embeddings: {
      ...DEFAULT_CONFIG.memory.embeddings,
      required: false,
    },
  },
};

mock.module("../../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb } from "../../memory/db.js";
import { clearEmbeddingBackendCache } from "../../memory/embedding-backend.js";
import { conversations, memoryObservations } from "../../memory/schema.js";
import type { MemoryRecallToolResult } from "./handlers.js";
import { handleMemoryRecall, handleMemorySave } from "./handlers.js";

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM memory_chunks");
  db.run("DELETE FROM memory_observations");
  db.run("DELETE FROM memory_episodes");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

// ── Helpers ──────────────────────────────────────────────────────────

function insertConversation(
  db: ReturnType<typeof getDb>,
  id: string,
  createdAt: number,
) {
  db.insert(conversations)
    .values({
      id,
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    })
    .run();
}

function parseResult(content: string): MemoryRecallToolResult {
  return JSON.parse(content) as MemoryRecallToolResult;
}

// ── Suite ────────────────────────────────────────────────────────────

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  clearTables();
  clearEmbeddingBackendCache();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleMemorySave", () => {
  // ── Input validation ──────────────────────────────────────────────

  test("returns error when statement is missing", async () => {
    const result = await handleMemorySave(
      { kind: "preference" },
      TEST_CONFIG,
      "conv-1",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("statement is required");
  });

  test("returns error when kind is missing", async () => {
    const result = await handleMemorySave(
      { statement: "some fact" },
      TEST_CONFIG,
      "conv-1",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("kind is required");
  });

  test("returns error when kind is invalid", async () => {
    const result = await handleMemorySave(
      { statement: "some fact", kind: "bogus" },
      TEST_CONFIG,
      "conv-1",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("kind is required");
  });

  // ── Happy path ────────────────────────────────────────────────────

  test("saves observation to simplified memory store", async () => {
    const db = getDb();
    const convId = "conv-save-test";
    insertConversation(db, convId, Date.now());

    const result = await handleMemorySave(
      {
        statement: "User prefers dark mode",
        kind: "preference",
        subject: "UI theme",
      },
      TEST_CONFIG,
      convId,
      undefined,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Saved to memory");
    expect(result.content).toContain("preference");
    expect(result.content).toContain("UI theme");

    // Verify the observation was written to the simplified tables
    const observations = db.select().from(memoryObservations).all();
    expect(observations.length).toBe(1);
    expect(observations[0].content).toContain("preference");
    expect(observations[0].content).toContain("UI theme");
    expect(observations[0].content).toContain("User prefers dark mode");
    expect(observations[0].source).toBe("tool:memory_save");
  });

  test("infers subject from statement when subject is omitted", async () => {
    const db = getDb();
    const convId = "conv-infer-subject";
    insertConversation(db, convId, Date.now());

    const result = await handleMemorySave(
      {
        statement:
          "The deployment pipeline uses GitHub Actions with self-hosted runners",
        kind: "project",
      },
      TEST_CONFIG,
      convId,
      undefined,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Saved to memory");
  });
});

describe("handleMemoryRecall", () => {
  // ── Input validation ──────────────────────────────────────────────

  test("returns error when query is missing", async () => {
    const result = await handleMemoryRecall({}, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("returns error when query is empty string", async () => {
    const result = await handleMemoryRecall({ query: "  " }, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("returns error when query is not a string", async () => {
    const result = await handleMemoryRecall({ query: 42 }, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  // ── Empty results ─────────────────────────────────────────────────

  test("returns empty result when no memories match", async () => {
    const result = await handleMemoryRecall(
      { query: "quantum physics" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    expect(parsed.resultCount).toBe(0);
    expect(parsed.text).toBe("No matching memories found.");
    expect(parsed.sources.semantic).toBe(0);
    expect(parsed.sources.recency).toBe(0);
  });

  // ── Result shape ─────────────────────────────────────────────────

  test("empty result shape matches MemoryRecallToolResult", async () => {
    const result = await handleMemoryRecall(
      { query: "nonexistent topic xyz123" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    expect(parsed.text).toBe("No matching memories found.");
    expect(parsed.resultCount).toBe(0);
    expect(typeof parsed.degraded).toBe("boolean");
    expect(parsed.sources.semantic).toBe(0);
    expect(parsed.sources.recency).toBe(0);
  });

  test("result shape has all expected fields", async () => {
    const result = await handleMemoryRecall(
      { query: "any topic" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    expect(typeof parsed.text).toBe("string");
    expect(typeof parsed.resultCount).toBe("number");
    expect(typeof parsed.degraded).toBe("boolean");
    expect(typeof parsed.sources).toBe("object");
    expect(typeof parsed.sources.semantic).toBe("number");
    expect(typeof parsed.sources.recency).toBe("number");
  });

  // ── Recall after save ─────────────────────────────────────────────

  test("recalls observation saved via memory_save", async () => {
    const db = getDb();
    const convId = "conv-recall-after-save";
    insertConversation(db, convId, Date.now());

    // Save a memory
    const saveResult = await handleMemorySave(
      {
        statement:
          "The project previously used Webpack but migrated to Vite",
        kind: "project",
        subject: "build tooling",
      },
      TEST_CONFIG,
      convId,
      undefined,
    );
    expect(saveResult.isError).toBe(false);

    // Recall it — the archive recall path uses keyword matching, so we query
    // with a term that appears in the saved observation.
    const recallResult = await handleMemoryRecall(
      { query: "remember what build tooling was mentioned previously" },
      TEST_CONFIG,
      "default",
    );

    expect(recallResult.isError).toBe(false);
    const parsed = parseResult(recallResult.content);
    // The archive recall path requires a recall trigger (explicit past
    // reference, analogy/debug pattern, or strong prefetch). The query
    // contains "remember" and "previously" which match PAST_REFERENCE_PATTERNS.
    expect(parsed.resultCount).toBeGreaterThanOrEqual(1);
    expect(parsed.text).toContain("build tooling");
  });

  // ── Error handling ────────────────────────────────────────────────
  // This test must be last: mock.module replaces the module for all
  // subsequent imports and cannot be cleanly reverted within the same
  // test file.

  test("retrieval failure returns error message, does not throw", async () => {
    mock.module("../../memory/archive-recall.js", () => ({
      buildArchiveRecall: () => {
        throw new Error("Simulated retrieval failure");
      },
    }));

    const { handleMemoryRecall: recallWithMock } =
      await import("./handlers.js");

    const result = await recallWithMock({ query: "test query" }, TEST_CONFIG);

    // The handler should catch the error and return an error result,
    // never throw
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Simulated retrieval failure");
  });
});
