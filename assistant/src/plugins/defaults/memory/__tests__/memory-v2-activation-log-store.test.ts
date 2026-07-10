import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { memoryV2ActivationLogs } from "../../../../persistence/schema/index.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  type MemoryV2ConceptRowRecord,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

await initializeDb();

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

  test("round-trip: router-mode log row with zeroed activations and source: 'router'", () => {
    const conversationId = "conv-router";
    const messageId = "msg-router";

    const routerConcepts: MemoryV2ConceptRowRecord[] = [
      {
        slug: "concept-router-a",
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "router",
        status: "injected",
      },
      {
        slug: "concept-router-b",
        finalActivation: 0,
        ownActivation: 0,
        priorActivation: 0,
        simUser: 0,
        simAssistant: 0,
        simNow: 0,
        simUserRerankBoost: 0,
        simAssistantRerankBoost: 0,
        inRerankPool: false,
        spreadContribution: 0,
        source: "router",
        status: "not_injected",
      },
    ];

    recordMemoryV2ActivationLog({
      conversationId,
      turn: 7,
      mode: "router",
      concepts: routerConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(7);
    expect(result!.mode).toBe("router");
    expect(result!.concepts).toEqual(routerConcepts);
    expect(result!.config).toEqual(sampleConfig);
    for (const concept of result!.concepts) {
      expect(concept.source).toBe("router");
      expect(concept.finalActivation).toBe(0);
      expect(concept.ownActivation).toBe(0);
      expect(concept.priorActivation).toBe(0);
      expect(concept.simUser).toBe(0);
      expect(concept.simAssistant).toBe(0);
      expect(concept.simNow).toBe(0);
      expect(concept.simUserRerankBoost).toBe(0);
      expect(concept.simAssistantRerankBoost).toBe(0);
      expect(concept.spreadContribution).toBe(0);
    }
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

  test("backfill skips v3_shadow rows, leaving their messageId null", () => {
    const conversationId = "conv-shadow-backfill";

    // A live router row (null messageId) and a detached v3_shadow row (null
    // messageId) coexist in the same conversation.
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "router",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "v3_shadow",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, "msg-live");

    const db = getDb();
    const rows = db.select().from(memoryV2ActivationLogs).all();
    const byMode = new Map(rows.map((r) => [r.mode, r]));
    // The live router row got stamped; the shadow row stayed null (not
    // mis-attributed to the live message).
    expect(byMode.get("router")!.messageId).toBe("msg-live");
    expect(byMode.get("v3_shadow")!.messageId).toBeNull();
  });
});
