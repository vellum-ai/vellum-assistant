import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { conversations, toolInvocations } from "./schema.js";
import { queryUnreportedToolExecutionEvents } from "./tool-execution-events-store.js";

initializeDb();

const CONVERSATION_ID = "conv-tool-exec-store-test";

interface InsertSpec {
  id: string;
  createdAt: number;
  toolName?: string;
  skillId?: string | null;
  decision?: string;
  riskLevel?: string;
  durationMs?: number;
}

function insertInvocation(spec: InsertSpec): void {
  getDb()
    .insert(toolInvocations)
    .values({
      id: spec.id,
      conversationId: CONVERSATION_ID,
      toolName: spec.toolName ?? "calendar_list_events",
      input: '{"secret":"raw tool args — must never leave the device"}',
      result: '{"secret":"raw tool output — must never leave the device"}',
      decision: spec.decision ?? "allow",
      riskLevel: spec.riskLevel ?? "low",
      skillId: spec.skillId ?? null,
      durationMs: spec.durationMs ?? 12,
      createdAt: spec.createdAt,
    })
    .run();
}

describe("tool-execution-events-store", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(toolInvocations).run();
    // tool_invocations has an enforced FK to conversations.
    db.insert(conversations)
      .values({
        id: CONVERSATION_ID,
        title: "test",
        createdAt: 1000,
        updatedAt: 1000,
      })
      .onConflictDoNothing()
      .run();
  });

  test("returns rows in (createdAt, id) order with projected fields", () => {
    insertInvocation({
      id: "ti-b",
      createdAt: 2000,
      toolName: "web_search",
      skillId: "research-skill",
      decision: "denied",
      riskLevel: "high",
      durationMs: 7,
    });
    insertInvocation({ id: "ti-a", createdAt: 1000 });

    const rows = queryUnreportedToolExecutionEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-a", "ti-b"]);
    expect(rows[0]).toEqual({
      id: "ti-a",
      toolName: "calendar_list_events",
      skillId: null,
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      conversationId: CONVERSATION_ID,
      createdAt: 1000,
    });
    expect(rows[1]).toMatchObject({
      toolName: "web_search",
      skillId: "research-skill",
      decision: "denied",
      riskLevel: "high",
      durationMs: 7,
    });
    // Raw tool args/outputs are potentially PII — the projection must
    // never include them.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("input");
      expect(Object.keys(row)).not.toContain("result");
    }
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertInvocation({ id: "ti-1", createdAt: 5000 });
    insertInvocation({ id: "ti-2", createdAt: 5000 });
    insertInvocation({ id: "ti-3", createdAt: 6000 });

    const first = queryUnreportedToolExecutionEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["ti-1"]);

    const second = queryUnreportedToolExecutionEvents(
      first[0].createdAt,
      first[0].id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["ti-2", "ti-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedToolExecutionEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["ti-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1];
    expect(
      queryUnreportedToolExecutionEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("skill-routed lifecycle events persist skill_id end to end; direct calls stay null", () => {
    // Default recorder = recordToolInvocation, so this exercises the full
    // audit listener → tool_invocations → telemetry projection chain.
    const listener = createToolAuditListener();

    listener({
      type: "executed",
      toolName: "task_create",
      input: { title: "t" },
      workingDir: "/tmp",
      conversationId: CONVERSATION_ID,
      skillId: "tasks-skill",
      riskLevel: "low",
      decision: "allow",
      durationMs: 4,
      result: { content: "ok", isError: false },
    });
    listener({
      type: "executed",
      toolName: "bash",
      input: { command: "ls" },
      workingDir: "/tmp",
      conversationId: CONVERSATION_ID,
      riskLevel: "low",
      decision: "allow",
      durationMs: 2,
      result: { content: "ok", isError: false },
    });

    const rows = queryUnreportedToolExecutionEvents(0, undefined, 100);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.toolName === "task_create")?.skillId).toBe(
      "tasks-skill",
    );
    expect(rows.find((r) => r.toolName === "bash")?.skillId).toBeNull();
  });

  test("honors the limit", () => {
    insertInvocation({ id: "ti-l1", createdAt: 1000 });
    insertInvocation({ id: "ti-l2", createdAt: 2000 });
    insertInvocation({ id: "ti-l3", createdAt: 3000 });

    const rows = queryUnreportedToolExecutionEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["ti-l1", "ti-l2"]);
  });
});
