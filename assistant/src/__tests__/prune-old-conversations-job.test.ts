import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { getDb, getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { pruneOldConversationsJob } from "../persistence/job-handlers/cleanup.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import {
  conversations,
  telemetryEvents,
  toolInvocations,
} from "../persistence/schema/index.js";

await initializeDb();

const STALE_ID = "conv-prune-job-stale";
const FRESH_ID = "conv-prune-job-fresh";

const JOB = { payload: {} } as unknown as MemoryJob;
const CONFIG = {
  memory: { cleanup: { conversationRetentionDays: 30 } },
} as unknown as AssistantConfig;

function seedConversation(id: string, updatedAt: number): void {
  const db = getDb();
  db.insert(conversations)
    .values({ id, title: "test", createdAt: updatedAt, updatedAt })
    .run();
  db.insert(toolInvocations)
    .values({
      id: `ti-${id}`,
      conversationId: id,
      toolName: "calendar_list_events",
      input: "{}",
      result: "{}",
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      createdAt: updatedAt,
    })
    .run();
  // Pending conversation-scoped telemetry rows live in the telemetry_events
  // outbox on the dedicated telemetry DB.
  getTelemetryDb()!
    .insert(telemetryEvents)
    .values({
      id: `te-${id}`,
      name: "skill_loaded",
      createdAt: updatedAt,
      conversationId: id,
      payload: "{}",
    })
    .run();
}

function countRows(conversationId: string): {
  invocations: number;
  telemetryRows: number;
} {
  const db = getDb();
  return {
    invocations: db
      .select()
      .from(toolInvocations)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
    telemetryRows: getTelemetryDb()!
      .select()
      .from(telemetryEvents)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
  };
}

describe("pruneOldConversationsJob", () => {
  beforeEach(() => {
    const db = getDb();
    getTelemetryDb()!.delete(telemetryEvents).run();
    db.delete(toolInvocations).run();
    db.delete(conversations).run();
  });

  test("deletes non-cascading rows — including pending telemetry_events — for pruned conversations only", () => {
    const staleUpdatedAt = Date.now() - 60 * 86_400_000;
    seedConversation(STALE_ID, staleUpdatedAt);
    seedConversation(FRESH_ID, Date.now());

    pruneOldConversationsJob(JOB, CONFIG);

    expect(countRows(STALE_ID)).toEqual({ invocations: 0, telemetryRows: 0 });
    expect(countRows(FRESH_ID)).toEqual({ invocations: 1, telemetryRows: 1 });
    const remaining = getDb().select().from(conversations).all();
    expect(remaining.map((c) => c.id)).toEqual([FRESH_ID]);
  });

  test("retentionDays of 0 is a no-op (keep forever)", () => {
    const ancientUpdatedAt = Date.now() - 999 * 86_400_000;
    seedConversation(STALE_ID, ancientUpdatedAt);

    pruneOldConversationsJob(JOB, {
      memory: { cleanup: { conversationRetentionDays: 0 } },
    } as unknown as AssistantConfig);

    const remaining = getDb().select().from(conversations).all();
    expect(remaining.map((c) => c.id)).toEqual([STALE_ID]);
  });
});
