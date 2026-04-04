import { beforeEach, describe, expect, mock, test } from "bun:test";

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

import { getDb, initializeDb } from "../memory/db.js";
import {
  backfillMemoryRecallLogMessageId,
  getMemoryRecallLogByMessageIds,
  normalizeTopCandidates,
  recordMemoryRecallLog,
} from "../memory/memory-recall-log-store.js";
import { memoryRecallLogs } from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(memoryRecallLogs).run();
}

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
      queryContext: "what is the weather like",
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
    expect(result!.queryContext).toBe("what is the weather like");
  });

  test("queryContext defaults to null when omitted", () => {
    const conversationId = "conv-no-query-ctx";
    const messageId = "msg-no-query-ctx";

    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: false,
      semanticHits: 1,
      mergedCount: 1,
      selectedCount: 1,
      tier1Count: 1,
      tier2Count: 0,
      hybridSearchLatencyMs: 50,
      sparseVectorUsed: false,
      injectedTokens: 100,
      latencyMs: 80,
      topCandidatesJson: [],
    });

    backfillMemoryRecallLogMessageId(conversationId, messageId);

    const result = getMemoryRecallLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.queryContext).toBeNull();
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

  test("normalizes SSE-event format candidates to inspector format on read", () => {
    const conversationId = "conv-normalize-sse";
    const messageId = "msg-normalize-sse";

    // Store candidates in SSE-event format (key/finalScore/semantic/recency/kind)
    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: false,
      semanticHits: 2,
      mergedCount: 1,
      selectedCount: 1,
      tier1Count: 1,
      tier2Count: 0,
      hybridSearchLatencyMs: 100,
      sparseVectorUsed: false,
      injectedTokens: 200,
      latencyMs: 120,
      topCandidatesJson: [
        {
          key: "node-abc",
          finalScore: 0.85,
          semantic: 0.9,
          recency: 0.1,
          kind: "episode",
          type: "episodic",
        },
      ],
    });

    backfillMemoryRecallLogMessageId(conversationId, messageId);

    const result = getMemoryRecallLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    const candidates = result!.topCandidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      nodeId: "node-abc",
      score: 0.85,
      semanticSimilarity: 0.9,
      recencyBoost: 0.1,
      type: "episodic",
    });
    // kind should be stripped
    expect(candidates[0]).not.toHaveProperty("kind");
    // Old field names should not be present
    expect(candidates[0]).not.toHaveProperty("key");
    expect(candidates[0]).not.toHaveProperty("finalScore");
    expect(candidates[0]).not.toHaveProperty("semantic");
    expect(candidates[0]).not.toHaveProperty("recency");
  });

  test("passes through candidates already in inspector format unchanged", () => {
    const conversationId = "conv-normalize-inspector";
    const messageId = "msg-normalize-inspector";

    // Store candidates already in inspector format (nodeId/score/semanticSimilarity/recencyBoost)
    recordMemoryRecallLog({
      conversationId,
      enabled: true,
      degraded: false,
      semanticHits: 1,
      mergedCount: 1,
      selectedCount: 1,
      tier1Count: 1,
      tier2Count: 0,
      hybridSearchLatencyMs: 80,
      sparseVectorUsed: false,
      injectedTokens: 100,
      latencyMs: 90,
      topCandidatesJson: [
        {
          nodeId: "node-xyz",
          score: 0.92,
          semanticSimilarity: 0.88,
          recencyBoost: 0.05,
          type: "semantic",
        },
      ],
    });

    backfillMemoryRecallLogMessageId(conversationId, messageId);

    const result = getMemoryRecallLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    const candidates = result!.topCandidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      nodeId: "node-xyz",
      score: 0.92,
      semanticSimilarity: 0.88,
      recencyBoost: 0.05,
      type: "semantic",
    });
  });

  test("normalizeTopCandidates handles non-array input", () => {
    expect(normalizeTopCandidates(null)).toBeNull();
    expect(normalizeTopCandidates("not-an-array")).toBe("not-an-array");
    expect(normalizeTopCandidates(42)).toBe(42);
  });
});
