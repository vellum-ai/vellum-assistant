import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { conversations, toolInvocations } from "./schema.js";
import { queryUnreportedToolExecutedEvents } from "./tool-executed-events-store.js";

initializeDb();

const CONVERSATION_ID = "conv-tool-executed-store-test";

/**
 * Sentinel embedded in the seeded raw input/result payloads. Asserted to
 * never appear in any projection — raw tool args/outputs must never leave
 * the device.
 */
const PII_SENTINEL = "must never leave the device";

interface SeedSpec {
  id: string;
  createdAt: number;
  toolName?: string;
  decision?: string;
  durationMs?: number;
  argBytes?: number | null;
  resultBytes?: number | null;
  provider?: string | null;
  model?: string | null;
  inferenceProfile?: string | null;
  inferenceProfileSource?: string | null;
}

function insertInvocation(spec: SeedSpec): void {
  const db = getDb();
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
  db.insert(toolInvocations)
    .values({
      id: spec.id,
      conversationId: CONVERSATION_ID,
      toolName: spec.toolName ?? "calendar_list_events",
      input: `{"secret":"raw tool args — ${PII_SENTINEL}"}`,
      result: `{"secret":"raw tool output — ${PII_SENTINEL}"}`,
      decision: spec.decision ?? "allow",
      riskLevel: "low",
      durationMs: spec.durationMs ?? 12,
      createdAt: spec.createdAt,
      // Post-migration writer paths always compute byte sizes (legacy
      // pre-migration rows are the only null-argBytes rows), so the seed
      // defaults to non-null. Pass an explicit null to seed a legacy row.
      argBytes: spec.argBytes !== undefined ? spec.argBytes : 2,
      resultBytes: spec.resultBytes !== undefined ? spec.resultBytes : 9,
      provider: spec.provider ?? null,
      model: spec.model ?? null,
      inferenceProfile: spec.inferenceProfile ?? null,
      inferenceProfileSource: spec.inferenceProfileSource ?? null,
    })
    .run();
}

describe("tool-executed-events-store", () => {
  beforeEach(() => {
    getDb().delete(toolInvocations).run();
  });

  test("projects telemetry fields in (createdAt, id) order without input/result", () => {
    insertInvocation({
      id: "ti-b",
      createdAt: 2000,
      toolName: "web_search",
      decision: "error",
      durationMs: 7,
    });
    insertInvocation({
      id: "ti-a",
      createdAt: 1000,
      argBytes: 42,
      resultBytes: 9001,
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
    });

    const rows = queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-a", "ti-b"]);
    expect(rows[0]).toEqual({
      id: "ti-a",
      toolName: "calendar_list_events",
      decision: "allow",
      durationMs: 12,
      argBytes: 42,
      resultBytes: 9001,
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
      conversationId: CONVERSATION_ID,
      createdAt: 1000,
    });
    expect(rows[1]).toMatchObject({
      toolName: "web_search",
      decision: "error",
      durationMs: 7,
    });
    // Raw tool args/outputs are potentially PII — the projection must
    // never include them.
    expect(JSON.stringify(rows)).not.toContain(PII_SENTINEL);
  });

  test("excludes permission-denied rows", () => {
    insertInvocation({ id: "ti-denied", createdAt: 1000, decision: "denied" });
    insertInvocation({ id: "ti-allow", createdAt: 2000 });
    insertInvocation({ id: "ti-error", createdAt: 3000, decision: "error" });

    const rows = queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-allow", "ti-error"]);
  });

  test("excludes legacy pre-migration rows (null arg_bytes)", () => {
    // Pre-migration-278 rows were already shipped under the since-reverted
    // tool_execution event type — they must never be projected, even from
    // a zero watermark.
    insertInvocation({
      id: "ti-legacy",
      createdAt: 1000,
      argBytes: null,
      resultBytes: null,
    });
    insertInvocation({ id: "ti-new", createdAt: 2000 });

    const rows = queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-new"]);
  });

  test("post-migration rows project with null attribution columns", () => {
    insertInvocation({ id: "ti-no-attr", createdAt: 1000 });

    const rows = queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows[0]).toMatchObject({
      argBytes: 2,
      resultBytes: 9,
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertInvocation({ id: "ti-1", createdAt: 5000 });
    insertInvocation({ id: "ti-2", createdAt: 5000 });
    insertInvocation({ id: "ti-3", createdAt: 6000 });

    const first = queryUnreportedToolExecutedEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["ti-1"]);

    const second = queryUnreportedToolExecutedEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["ti-2", "ti-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedToolExecutedEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["ti-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedToolExecutedEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("honors the limit", () => {
    insertInvocation({ id: "ti-l1", createdAt: 1000 });
    insertInvocation({ id: "ti-l2", createdAt: 2000 });
    insertInvocation({ id: "ti-l3", createdAt: 3000 });

    const rows = queryUnreportedToolExecutedEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["ti-l1", "ti-l2"]);
  });
});
