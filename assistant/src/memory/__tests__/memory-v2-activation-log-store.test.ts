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
  type MemoryV2ConceptRowRecord,
  type MemoryV2ConfigSnapshot,
  type MemoryV2SkillRowRecord,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { memoryV2ActivationLogs } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
}

const sampleConcepts: MemoryV2ConceptRowRecord[] = [
  {
    slug: "concept-a",
    finalActivation: 0.9,
    ownActivation: 0.7,
    priorActivation: 0.5,
    simUser: 0.6,
    simAssistant: 0.4,
    simNow: 0.3,
    spreadContribution: 0.2,
    source: "both",
    status: "injected",
  },
  {
    slug: "concept-b",
    finalActivation: 0.4,
    ownActivation: 0.3,
    priorActivation: 0.1,
    simUser: 0.2,
    simAssistant: 0.1,
    simNow: 0.05,
    spreadContribution: 0.0,
    source: "ann_top50",
    status: "not_injected",
  },
];

const sampleSkills: MemoryV2SkillRowRecord[] = [
  {
    id: "skill-1",
    activation: 0.8,
    simUser: 0.5,
    simAssistant: 0.4,
    simNow: 0.3,
    status: "injected",
  },
];

const sampleConfig: MemoryV2ConfigSnapshot = {
  d: 0.85,
  c_user: 1.0,
  c_assistant: 0.5,
  c_now: 0.25,
  k: 5,
  hops: 2,
  top_k: 10,
  top_k_skills: 3,
  epsilon: 0.001,
};

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
      skills: sampleSkills,
      config: sampleConfig,
    });

    backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(3);
    expect(result!.mode).toBe("per-turn");
    expect(result!.concepts).toEqual(sampleConcepts);
    expect(result!.skills).toEqual(sampleSkills);
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
      skills: sampleSkills,
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId,
      turn: 2,
      mode: "per-turn",
      concepts: sampleConcepts,
      skills: sampleSkills,
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
      skills: sampleSkills,
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
