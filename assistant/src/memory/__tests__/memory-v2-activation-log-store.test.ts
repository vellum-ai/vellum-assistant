import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { memoryV2ActivationLogs } from "../schema.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
}

describe("memory-v2-activation-log-store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("round-trip: record → backfill messageId → query by messageId", () => {
    const conversationId = "conv-1";
    const messageId = "msg-1";

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(3);
    expect(result!.mode).toBe("per-turn");
    expect(result!.concepts).toEqual(sampleConcepts);
    expect(result!.config).toEqual(sampleConfig);
  });

  test("returns null for empty messageIds array", () => {
    const result = getMemoryV2ActivationLogByMessageIds([]);
    expect(result).toBeNull();
  });

  test("backfill only updates rows with NULL messageId", () => {
    const conversationId = "conv-2";

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 2,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // First backfill: both rows should now have msg-a.
    backfillMemoryV2ActivationMessageId(conversationId, "msg-a");

    const db = getDb();
    const afterFirstBackfill = db.select().from(memoryV2ActivationLogs).all();
    expect(afterFirstBackfill).toHaveLength(2);
    for (const row of afterFirstBackfill) {
      expect(row.messageId).toBe("msg-a");
    }

    // Record a third row (messageId is NULL initially).
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // Second backfill with msg-b should only set the third row,
    // and must not overwrite the first two rows already set to msg-a.
    backfillMemoryV2ActivationMessageId(conversationId, "msg-b");

    const afterSecondBackfill = db.select().from(memoryV2ActivationLogs).all();
    const byTurn = new Map(afterSecondBackfill.map((r) => [r.turn, r]));
    expect(byTurn.get(1)!.messageId).toBe("msg-a");
    expect(byTurn.get(2)!.messageId).toBe("msg-a");
    expect(byTurn.get(3)!.messageId).toBe("msg-b");
  });
});
