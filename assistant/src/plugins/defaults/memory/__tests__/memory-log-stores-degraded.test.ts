/**
 * Degraded-mode coverage for the relocated per-turn memory log tables: with
 * the dedicated memory database unavailable, writes are best-effort no-ops
 * and reads return empty/zero results — nothing throws mid-turn.
 *
 * Unavailability is simulated by installing a connection with no underlying
 * sqlite client into the `memory` singleton slot, so `getMemorySqlite()`
 * resolves to null without mocking any module (module mocks would leak into
 * other test files in the same run).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import {
  backfillMemoryRecallLogMessageId,
  getMemoryRecallLogByMessageIds,
  recordMemoryRecallLog,
} from "../memory-recall-log-store.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { getConceptFrequencySummary } from "../memory-v2-concept-frequency.js";
import { extractOracleTurns } from "../v2/harness/oracle.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

// listPages returns [] for a workspace with no concepts directory.
const WORKSPACE = "/tmp/memory-log-stores-degraded-nonexistent-workspace";

beforeEach(() => {
  setStoredDb("memory", { $client: null } as unknown as DrizzleDb, () => {});
});

afterEach(() => {
  clearStoredDb("memory");
});

describe("memory log stores without a memory database", () => {
  test("activation-log writes no-op and reads return null", () => {
    expect(() =>
      recordMemoryV2ActivationLog({
        conversationId: "conv-1",
        turn: 1,
        mode: "per-turn",
        concepts: sampleConcepts,
        config: sampleConfig,
      }),
    ).not.toThrow();
    expect(() =>
      backfillMemoryV2ActivationMessageId("conv-1", "msg-1"),
    ).not.toThrow();
    expect(getMemoryV2ActivationLogByMessageIds(["msg-1"])).toBeNull();
  });

  test("recall-log writes no-op and reads return null", () => {
    expect(() =>
      recordMemoryRecallLog({
        conversationId: "conv-1",
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
      }),
    ).not.toThrow();
    expect(() =>
      backfillMemoryRecallLogMessageId("conv-1", "msg-1"),
    ).not.toThrow();
    expect(getMemoryRecallLogByMessageIds(["msg-1"])).toBeNull();
  });

  test("concept-frequency degrades to zero counts", async () => {
    const result = await getConceptFrequencySummary(WORKSPACE);
    expect(result.totals).toEqual({ logCount: 0, conceptOccurrences: 0 });
    expect(result.concepts).toEqual([]);
    expect(result.neverEvaluatedSlugs).toEqual([]);
  });

  test("oracle extraction returns no turns", () => {
    expect(extractOracleTurns({} as DrizzleDb)).toEqual([]);
  });
});
