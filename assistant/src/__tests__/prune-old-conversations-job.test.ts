import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { pruneOldConversationsJob } from "../persistence/job-handlers/cleanup.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import {
  conversations,
  skillLoadedEvents,
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
  db.insert(skillLoadedEvents)
    .values({
      id: `sl-${id}`,
      createdAt: updatedAt,
      conversationId: id,
      skillName: "test-skill",
    })
    .run();
}

function countRows(conversationId: string): {
  invocations: number;
  skillLoads: number;
} {
  const db = getDb();
  return {
    invocations: db
      .select()
      .from(toolInvocations)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
    skillLoads: db
      .select()
      .from(skillLoadedEvents)
      .all()
      .filter((r) => r.conversationId === conversationId).length,
  };
}

describe("pruneOldConversationsJob", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(skillLoadedEvents).run();
    db.delete(toolInvocations).run();
    db.delete(conversations).run();
  });

  test("deletes non-cascading rows — including skill_loaded_events — for pruned conversations only", () => {
    const staleUpdatedAt = Date.now() - 60 * 86_400_000;
    seedConversation(STALE_ID, staleUpdatedAt);
    seedConversation(FRESH_ID, Date.now());

    pruneOldConversationsJob(JOB, CONFIG);

    expect(countRows(STALE_ID)).toEqual({ invocations: 0, skillLoads: 0 });
    expect(countRows(FRESH_ID)).toEqual({ invocations: 1, skillLoads: 1 });
    const remaining = getDb().select().from(conversations).all();
    expect(remaining.map((c) => c.id)).toEqual([FRESH_ID]);
  });
});
