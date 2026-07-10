import { beforeEach, describe, expect, mock, test } from "bun:test";

// Toggle for the share_analytics opt-out gate the audit listener consults
// when populating the telemetry columns.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import {
  seedToolInvocation,
  TOOL_INVOCATION_PII_SENTINEL as PII_SENTINEL,
  type ToolInvocationSeedSpec,
} from "../__tests__/test-support/tool-invocation-seed.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, toolInvocations } from "../persistence/schema/index.js";
import { recordToolExecuted } from "./tool-audit.js";
import { queryUnreportedToolExecutedEvents } from "./tool-executed-events-store.js";

await initializeDb();

const CONVERSATION_ID = "conv-tool-executed-store-test";

function insertInvocation(
  spec: Omit<ToolInvocationSeedSpec, "conversationId">,
): void {
  seedToolInvocation(
    { db: getDb(), conversations, toolInvocations },
    { ...spec, conversationId: CONVERSATION_ID },
  );
}

describe("tool-executed-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
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
    // Already shipped under the reverted tool_execution type — never
    // projected, even from a zero watermark.
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

  test("rows recorded while opted out are never projected, even from a zero watermark", () => {
    // End-to-end through the real audit terminal: the write-time opt-out
    // gate persists NULL telemetry columns, which the arg_bytes IS NOT NULL
    // filter excludes permanently — the same mechanism as legacy rows. No
    // watermark state is involved, so no later opt-in can ship these rows.
    const recordExecuted = (toolName: string): void =>
      recordToolExecuted({
        conversationId: CONVERSATION_ID,
        toolName,
        input: { path: "/tmp/a" },
        resultContent: "ok",
        resultBytes: 2,
        decision: "allow",
        riskLevel: "low",
        durationMs: 5,
        attribution: null,
        wasPrompted: false,
      });

    recordExecuted("t-opted-in-before");

    shareAnalytics = false;
    recordExecuted("t-opted-out");

    shareAnalytics = true;
    recordExecuted("t-opted-in-after");

    // Mid-session opt-out flip: only rows recorded while opted in project.
    const rows = queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.toolName).sort()).toEqual([
      "t-opted-in-after",
      "t-opted-in-before",
    ]);

    // The audit row itself is still recorded — only its telemetry columns
    // are NULL.
    const auditRows = getDb().select().from(toolInvocations).all();
    expect(auditRows).toHaveLength(3);
    const optedOut = auditRows.find((r) => r.toolName === "t-opted-out");
    expect(optedOut).toMatchObject({
      decision: "allow",
      argBytes: null,
      resultBytes: null,
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
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
