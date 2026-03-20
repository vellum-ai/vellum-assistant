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

const testDir = mkdtempSync(join(tmpdir(), "jobs-store-qdrant-breaker-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  claimMemoryJobs,
  enqueueMemoryJob,
  type MemoryJobType,
} from "../memory/jobs-store.js";
import {
  _resetQdrantBreaker,
  withQdrantBreaker,
} from "../memory/qdrant-circuit-breaker.js";

describe("claimMemoryJobs with Qdrant circuit breaker", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_jobs");
    _resetQdrantBreaker();
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("claims embed jobs when circuit breaker is closed (healthy)", () => {
    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("embed_item", { itemId: "item-1" });
    enqueueMemoryJob("extract_items", { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(10);
    const types = claimed.map((j) => j.type);

    expect(types).toContain("embed_segment");
    expect(types).toContain("embed_item");
    expect(types).toContain("extract_items");
    expect(claimed).toHaveLength(3);
  });

  test("skips embed jobs when circuit breaker is open", async () => {
    // Trip the circuit breaker by recording 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("embed_item", { itemId: "item-1" });
    enqueueMemoryJob("embed_summary", { summaryId: "sum-1" });
    enqueueMemoryJob("extract_items", { conversationId: "conv-1" });
    enqueueMemoryJob("build_conversation_summary", {
      conversationId: "conv-1",
    });

    const claimed = claimMemoryJobs(10);
    const types = claimed.map((j) => j.type);

    // Only non-embed jobs should be claimed
    expect(types).toContain("extract_items");
    expect(types).toContain("build_conversation_summary");
    expect(types).not.toContain("embed_segment");
    expect(types).not.toContain("embed_item");
    expect(types).not.toContain("embed_summary");
    expect(claimed).toHaveLength(2);
  });

  test("resumes claiming embed jobs after circuit breaker closes", async () => {
    // Trip the circuit breaker
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    // Verify embed jobs are skipped while open
    enqueueMemoryJob("embed_segment", { segmentId: "seg-1" });
    enqueueMemoryJob("extract_items", { conversationId: "conv-1" });

    const claimedWhileOpen = claimMemoryJobs(10);
    expect(claimedWhileOpen.map((j) => j.type)).not.toContain("embed_segment");

    // Reset breaker (simulates successful probe closing the circuit)
    _resetQdrantBreaker();

    // Re-enqueue an embed job (the previous one is now "running")
    enqueueMemoryJob("embed_item", { itemId: "item-2" });

    const claimedAfterClose = claimMemoryJobs(10);
    const types = claimedAfterClose.map((j) => j.type);

    expect(types).toContain("embed_item");
  });

  test("all embed job types are skipped when breaker is open", async () => {
    const embedTypes: MemoryJobType[] = [
      "embed_segment",
      "embed_item",
      "embed_summary",
      "embed_media",
      "embed_attachment",
    ];

    // Trip the circuit breaker
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }

    // Enqueue one of each embed type
    for (const type of embedTypes) {
      enqueueMemoryJob(type, { id: `test-${type}` });
    }
    // Also enqueue a non-embed job
    enqueueMemoryJob("extract_entities", { conversationId: "conv-1" });

    const claimed = claimMemoryJobs(20);
    const types = claimed.map((j) => j.type);

    // Only the non-embed job should be claimed
    expect(claimed).toHaveLength(1);
    expect(types).toEqual(["extract_entities"]);
  });
});
