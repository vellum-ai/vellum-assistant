import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { AssistantConfig } from "../config/schema.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { pruneOldToolInvocationsJob } from "../persistence/job-handlers/cleanup.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import { conversations, toolInvocations } from "../persistence/schema/index.js";

await initializeDb();

const DAY_MS = 86_400_000;

function seedInvocation(id: string, createdAt: number): void {
  getDb()
    .insert(toolInvocations)
    .values({
      id,
      conversationId: "conv-1",
      toolName: "bash",
      input: "{}",
      result: "{}",
      decision: "allow",
      riskLevel: "low",
      durationMs: 5,
      createdAt,
    })
    .run();
}

function remainingIds(): string[] {
  return getDb()
    .select()
    .from(toolInvocations)
    .all()
    .map((r) => r.id)
    .sort();
}

function job(payload: Record<string, unknown> = {}): MemoryJob {
  return { payload } as unknown as MemoryJob;
}

function config(retentionDays: number): AssistantConfig {
  return { auditLog: { retentionDays } } as unknown as AssistantConfig;
}

describe("pruneOldToolInvocationsJob", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(toolInvocations).run();
    db.delete(conversations).run();
    // tool_invocations.conversation_id is an FK into conversations.
    db.insert(conversations)
      .values({
        id: "conv-1",
        title: "test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  });

  test("deletes audit rows older than auditLog.retentionDays, keeps recent ones", async () => {
    seedInvocation("old", Date.now() - 60 * DAY_MS);
    seedInvocation("fresh", Date.now());

    await pruneOldToolInvocationsJob(job(), config(30));

    expect(remainingIds()).toEqual(["fresh"]);
  });

  test("payload retentionDays overrides the config window", async () => {
    seedInvocation("ten-days", Date.now() - 10 * DAY_MS);

    // Config would keep it (30d), but the payload tightens to 7d.
    await pruneOldToolInvocationsJob(job({ retentionDays: 7 }), config(30));

    expect(remainingIds()).toEqual([]);
  });

  test("retentionDays of 0 is a no-op (keep forever)", async () => {
    seedInvocation("ancient", Date.now() - 999 * DAY_MS);

    await pruneOldToolInvocationsJob(job(), config(0));

    expect(remainingIds()).toEqual(["ancient"]);
  });
});
