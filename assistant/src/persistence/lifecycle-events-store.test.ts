import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Mutable consent gate, flipped per-test.
let shareAnalytics = true;
mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import * as dbConnection from "./db-connection.js";
import { getTelemetryDb, getTelemetrySqlite } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import {
  queryUnreportedLifecycleEvents,
  recordLifecycleEvent,
} from "./lifecycle-events-store.js";
import { lifecycleEvents } from "./schema.js";

await initializeDb();

function insertEvent(id: string, createdAt: number, eventName = "hatch"): void {
  getTelemetryDb()!
    .insert(lifecycleEvents)
    .values({ id, eventName, createdAt })
    .run();
}

/** Run `fn` with the dedicated telemetry connection reported as unavailable. */
function withTelemetryDbUnavailable(fn: () => void): void {
  const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("lifecycle-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    getTelemetryDb()!.delete(lifecycleEvents).run();
  });

  test("record + query round-trips and writes into the telemetry database", () => {
    const event = recordLifecycleEvent("app_open");
    expect(event).not.toBeNull();
    expect(event!.eventName).toBe("app_open");
    expect(event!.createdAt).toBeGreaterThan(0);

    const rows = queryUnreportedLifecycleEvents(0, undefined, 10);
    expect(rows).toEqual([event!]);

    const raw = getTelemetrySqlite()!
      .query(`SELECT id, event_name FROM lifecycle_events`)
      .all() as Array<{ id: string; event_name: string }>;
    expect(raw).toEqual([{ id: event!.id, event_name: "app_open" }]);
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    shareAnalytics = false;
    expect(recordLifecycleEvent("app_open")).toBeNull();
    expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("degrades when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      expect(recordLifecycleEvent("app_open")).toBeNull();
      expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toEqual([]);
    });

    expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("returns rows in (createdAt, id) order", () => {
    insertEvent("le-b", 2000);
    insertEvent("le-a", 1000);

    const rows = queryUnreportedLifecycleEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["le-a", "le-b"]);
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertEvent("le-1", 5000);
    insertEvent("le-2", 5000);
    insertEvent("le-3", 6000);

    const first = queryUnreportedLifecycleEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["le-1"]);

    const second = queryUnreportedLifecycleEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["le-2", "le-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedLifecycleEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["le-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedLifecycleEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("honors the limit", () => {
    insertEvent("le-l1", 1000);
    insertEvent("le-l2", 2000);
    insertEvent("le-l3", 3000);

    const rows = queryUnreportedLifecycleEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["le-l1", "le-l2"]);
  });
});
