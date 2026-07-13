import { beforeEach, describe, expect, mock, test } from "bun:test";

let shareAnalytics = true;

mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { telemetryEvents } from "../../persistence/schema/index.js";
import { APP_VERSION } from "../../version.js";
import { queryTelemetryOutboxBatch } from "../telemetry-events-outbox.js";
import { recordWatchdogEvent } from "../watchdog-events-store.js";

await initializeDb();

function pendingWatchdogPayloads(): Array<Record<string, unknown>> {
  return queryTelemetryOutboxBatch("watchdog", 100).map(
    (row) => JSON.parse(row.payload) as Record<string, unknown>,
  );
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(telemetryEvents).run();
}

describe("watchdog-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    clearEvents();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    recordWatchdogEvent({ checkName: "event_loop_blocked", value: 60000 });
    expect(queryTelemetryOutboxBatch("watchdog", 10)).toHaveLength(0);
  });

  test("records the full wire event, with detail as a nested object", () => {
    recordWatchdogEvent({
      checkName: "event_loop_blocked",
      value: 12345,
      detail: { reason: "no_bytes_60s", threshold_ms: 5000 },
    });

    const rows = queryTelemetryOutboxBatch("watchdog", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(JSON.parse(row.payload)).toEqual({
      type: "watchdog",
      daemon_event_id: row.id,
      recorded_at: row.createdAt,
      check_name: "event_loop_blocked",
      value: 12345,
      detail: { reason: "no_bytes_60s", threshold_ms: 5000 },
      assistant_version: APP_VERSION,
    });
  });

  test("omitted value and detail persist as null", () => {
    recordWatchdogEvent({ checkName: "stream_idle" });

    const payloads = pendingWatchdogPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      check_name: "stream_idle",
      value: null,
      detail: null,
    });
  });

  test("explicit null value and detail persist as null", () => {
    recordWatchdogEvent({
      checkName: "restart",
      value: null,
      detail: null,
    });

    const payloads = pendingWatchdogPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.value).toBeNull();
    expect(payloads[0]?.detail).toBeNull();
  });
});
