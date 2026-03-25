import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "memory-recall-log-store-test-")),
);
const workspaceDir = join(testDir, ".vellum", "workspace");

mock.module("../util/platform.js", () => ({
  getRootDir: () => join(testDir, ".vellum"),
  getDataDir: () => join(workspaceDir, "data"),
  getWorkspaceDir: () => workspaceDir,
  getConversationsDir: () => join(workspaceDir, "conversations"),
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
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  backfillMemoryRecallLogMessageId,
  getMemoryRecallLogByMessageIds,
  recordMemoryRecallLog,
} from "../memory/memory-recall-log-store.js";
import { memoryRecallLogs } from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(memoryRecallLogs).run();
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("memory-recall-log-store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("round-trip: record → backfill messageId → query by messageId", () => {
    const conversationId = "conv-1";
    const messageId = "msg-1";

    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: false,
      provider: "anthropic",
      model: "claude-sonnet",
      degradationJson: { reason: "none" },
      semanticHits: 5,
      mergedCount: 3,
      selectedCount: 2,
      tier1Count: 1,
      tier2Count: 1,
      hybridSearchLatencyMs: 150,
      sparseVectorUsed: true,
      injectedTokens: 500,
      latencyMs: 200,
      topCandidatesJson: [{ id: "c1", score: 0.9 }],
      injectedText: "some memory context",
      reason: "user query matched memories",
    });

    backfillMemoryRecallLogMessageId(conversationId, messageId);

    const result = getMemoryRecallLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.degraded).toBe(false);
    expect(result!.provider).toBe("anthropic");
    expect(result!.model).toBe("claude-sonnet");
    expect(result!.degradation).toEqual({ reason: "none" });
    expect(result!.semanticHits).toBe(5);
    expect(result!.mergedCount).toBe(3);
    expect(result!.selectedCount).toBe(2);
    expect(result!.tier1Count).toBe(1);
    expect(result!.tier2Count).toBe(1);
    expect(result!.hybridSearchLatencyMs).toBe(150);
    expect(result!.sparseVectorUsed).toBe(true);
    expect(result!.injectedTokens).toBe(500);
    expect(result!.latencyMs).toBe(200);
    expect(result!.topCandidates).toEqual([{ id: "c1", score: 0.9 }]);
    expect(result!.injectedText).toBe("some memory context");
    expect(result!.reason).toBe("user query matched memories");
  });

  test("returns null when no log exists for a messageId", () => {
    const result = getMemoryRecallLogByMessageIds(["nonexistent-msg"]);
    expect(result).toBeNull();
  });

  test("returns null for empty messageIds array", () => {
    const result = getMemoryRecallLogByMessageIds([]);
    expect(result).toBeNull();
  });

  test("backfill only updates rows with NULL messageId", () => {
    const conversationId = "conv-2";

    // Record first log and backfill with msg-a
    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: false,
      semanticHits: 3,
      mergedCount: 2,
      selectedCount: 1,
      tier1Count: 1,
      tier2Count: 0,
      hybridSearchLatencyMs: 100,
      sparseVectorUsed: false,
      injectedTokens: 300,
      latencyMs: 150,
      topCandidatesJson: [],
    });
    backfillMemoryRecallLogMessageId(conversationId, "msg-a");

    // Record second log (messageId is still NULL)
    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: true,
      degradationJson: { reason: "timeout" },
      semanticHits: 1,
      mergedCount: 1,
      selectedCount: 0,
      tier1Count: 0,
      tier2Count: 0,
      hybridSearchLatencyMs: 50,
      sparseVectorUsed: false,
      injectedTokens: 0,
      latencyMs: 80,
      topCandidatesJson: [],
    });

    // Backfill second log with msg-b
    backfillMemoryRecallLogMessageId(conversationId, "msg-b");

    // Verify first log still has msg-a
    const firstLog = getMemoryRecallLogByMessageIds(["msg-a"]);
    expect(firstLog).not.toBeNull();
    expect(firstLog!.degraded).toBe(false);

    // Verify second log has msg-b
    const secondLog = getMemoryRecallLogByMessageIds(["msg-b"]);
    expect(secondLog).not.toBeNull();
    expect(secondLog!.degraded).toBe(true);
  });
});
