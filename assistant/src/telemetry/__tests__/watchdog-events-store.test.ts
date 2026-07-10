import { beforeEach, describe, expect, mock, test } from "bun:test";

let shareAnalytics = true;

mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { watchdogEvents } from "../../persistence/schema/index.js";
import {
  queryUnreportedWatchdogEvents,
  recordWatchdogEvent,
} from "../watchdog-events-store.js";

await initializeDb();

function insertEvent(
  id: string,
  createdAt: number,
  checkName = "event_loop_blocked",
): void {
  const db = getTelemetryDb();
  if (!db) throw new Error("telemetry DB unavailable in test");
  db.insert(watchdogEvents).values({ id, createdAt, checkName }).run();
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) throw new Error("telemetry DB unavailable in test");
  db.delete(watchdogEvents).run();
}

describe("watchdog-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    clearEvents();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    recordWatchdogEvent({ checkName: "event_loop_blocked", value: 60000 });
    expect(queryUnreportedWatchdogEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("record + query round-trips all fields", () => {
    recordWatchdogEvent({
      checkName: "event_loop_blocked",
      value: 12345,
      detail: { reason: "no_bytes_60s", threshold_ms: 5000 },
    });

    const rows = queryUnreportedWatchdogEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.checkName).toBe("event_loop_blocked");
    expect(row.value).toBe(12345);
    expect(row.detail).toBe(
      JSON.stringify({ reason: "no_bytes_60s", threshold_ms: 5000 }),
    );
  });

  test("optional fields persist as null", () => {
    recordWatchdogEvent({ checkName: "stream_idle" });

    const rows = queryUnreportedWatchdogEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      checkName: "stream_idle",
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

    const rows = queryUnreportedWatchdogEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeNull();
    expect(rows[0]?.detail).toBeNull();
  });

  test("returns rows in (createdAt, id) order", () => {
    insertEvent("wd-b", 2000);
    insertEvent("wd-a", 1000);

    const rows = queryUnreportedWatchdogEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["wd-a", "wd-b"]);
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertEvent("wd-1", 5000);
    insertEvent("wd-2", 5000);
    insertEvent("wd-3", 6000);

    const first = queryUnreportedWatchdogEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["wd-1"]);

    const second = queryUnreportedWatchdogEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["wd-2", "wd-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedWatchdogEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["wd-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedWatchdogEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("resumes from a persisted watermark without re-reporting", () => {
    insertEvent("wd-w1", 1000);
    insertEvent("wd-w2", 2000);

    const batch = queryUnreportedWatchdogEvents(0, undefined, 100);
    const watermark = batch[batch.length - 1]!;

    insertEvent("wd-w3", 3000);

    const resumed = queryUnreportedWatchdogEvents(
      watermark.createdAt,
      watermark.id,
      100,
    );
    expect(resumed.map((r) => r.id)).toEqual(["wd-w3"]);
  });

  test("honors the limit", () => {
    insertEvent("wd-l1", 1000);
    insertEvent("wd-l2", 2000);
    insertEvent("wd-l3", 3000);

    const rows = queryUnreportedWatchdogEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["wd-l1", "wd-l2"]);
  });
});
