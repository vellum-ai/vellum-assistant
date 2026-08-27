import { beforeEach, describe, expect, test } from "bun:test";

import {
  resetOutboxTable,
  setShareAnalytics,
  withTelemetryDbUnavailable,
} from "../telemetry/__tests__/outbox-test-harness.js";
import { APP_VERSION } from "../version.js";
import { getTelemetrySqlite } from "./db-connection.js";
import {
  buildLifecycleTelemetryEvent,
  recordLifecycleEvent,
} from "./lifecycle-events-store.js";

interface RawOutboxRow {
  id: string;
  name: string;
  created_at: number;
  conversation_id: string | null;
  payload: string;
}

function outboxRows(): RawOutboxRow[] {
  return getTelemetrySqlite()!
    .query(
      `SELECT id, name, created_at, conversation_id, payload
       FROM telemetry_events ORDER BY created_at, id`,
    )
    .all() as RawOutboxRow[];
}

describe("lifecycle-events-store", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    resetOutboxTable();
  });

  test("record writes a telemetry_events outbox row carrying the wire payload", () => {
    const event = recordLifecycleEvent("app_open");
    expect(event).not.toBeNull();
    expect(event!.eventName).toBe("app_open");
    expect(event!.createdAt).toBeGreaterThan(0);

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: event!.id,
      name: "lifecycle",
      created_at: event!.createdAt,
      conversation_id: null,
    });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "lifecycle",
      daemon_event_id: event!.id,
      event_name: "app_open",
      recorded_at: event!.createdAt,
      assistant_version: APP_VERSION,
    });
  });

  test("carries the optional attributes onto the wire payload", () => {
    const event = recordLifecycleEvent("permission_prompt:bash", {
      toolName: "bash",
      riskLevel: "high",
      riskThreshold: "low",
      surface: "slack",
      conversationId: "conv-xyz",
    });
    expect(event).not.toBeNull();

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    // The conversation is stamped on the row too, so deleting the conversation
    // deletes the pending event with it.
    expect(rows[0]!.conversation_id).toBe("conv-xyz");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "lifecycle",
      daemon_event_id: event!.id,
      event_name: "permission_prompt:bash",
      recorded_at: event!.createdAt,
      assistant_version: APP_VERSION,
      tool_name: "bash",
      risk_level: "high",
      risk_threshold: "low",
      surface: "slack",
      conversation_id: "conv-xyz",
    });
  });

  test("omits attributes that are unset or empty", () => {
    // The wire schema requires at least one character, and one failing field
    // makes the server drop the whole event.
    const event = recordLifecycleEvent("permission_prompt:bash", {
      toolName: "bash",
      riskLevel: "high",
      surface: "",
    });

    expect(JSON.parse(outboxRows()[0]!.payload)).toEqual({
      type: "lifecycle",
      daemon_event_id: event!.id,
      event_name: "permission_prompt:bash",
      recorded_at: event!.createdAt,
      assistant_version: APP_VERSION,
      tool_name: "bash",
      risk_level: "high",
    });
    expect(outboxRows()[0]!.conversation_id).toBeNull();
  });

  test("buildLifecycleTelemetryEvent stamps the record-time binary version", () => {
    expect(buildLifecycleTelemetryEvent("id-1", "hatch", 1234)).toEqual({
      type: "lifecycle",
      daemon_event_id: "id-1",
      event_name: "hatch",
      recorded_at: 1234,
      assistant_version: APP_VERSION,
    });
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    setShareAnalytics(false);
    expect(recordLifecycleEvent("app_open")).toBeNull();
    expect(outboxRows()).toHaveLength(0);
  });

  test("degrades when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      expect(recordLifecycleEvent("app_open")).toBeNull();
    });

    expect(outboxRows()).toHaveLength(0);
  });
});
