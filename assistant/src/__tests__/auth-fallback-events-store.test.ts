import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import * as dbConnection from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  type AuthFallbackCount,
  recordAuthFallbackCounts,
} from "../security/auth-fallback-events-store.js";
import {
  discardPendingTelemetryOutboxEvents,
  queryTelemetryOutboxBatch,
} from "../telemetry/telemetry-events-outbox.js";
import type { AuthFallbackTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

await initializeDb();

function pendingRows() {
  return queryTelemetryOutboxBatch("auth_fallback", 100);
}

function pendingPayloads(): AuthFallbackTelemetryEvent[] {
  return pendingRows().map(
    (r) => JSON.parse(r.payload) as AuthFallbackTelemetryEvent,
  );
}

const SAMPLE: AuthFallbackCount[] = [
  {
    guard: "edge",
    path: "/v1/messages",
    failureKind: "missing_authorization",
    count: 7,
  },
  {
    guard: "edge-scoped",
    path: "/v1/files",
    failureKind: "insufficient_scope",
    count: 2,
  },
];

describe("auth-fallback-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    discardPendingTelemetryOutboxEvents("auth_fallback");
  });

  test("records one outbox row per count entry with the full wire payload", () => {
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(2);

    const rows = pendingRows();
    expect(rows.length).toBe(2);
    const payloads = rows.map(
      (r) => JSON.parse(r.payload) as AuthFallbackTelemetryEvent,
    );
    const byGuard = Object.fromEntries(payloads.map((p) => [p.guard, p]));
    expect(byGuard["edge"]).toEqual({
      type: "auth_fallback",
      daemon_event_id: expect.any(String),
      recorded_at: expect.any(Number),
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 7,
      window_start: 1000,
      window_end: 2000,
      assistant_version: APP_VERSION,
    });
    expect(byGuard["edge-scoped"]).toMatchObject({
      path: "/v1/files",
      failure_kind: "insufficient_scope",
      count: 2,
    });
    // The wire daemon_event_id matches the outbox row id, and recorded_at
    // matches the row's created_at (record-time stamping).
    rows.forEach((row, i) => {
      expect(payloads[i].daemon_event_id).toBe(row.id);
      expect(payloads[i].recorded_at).toBe(row.createdAt);
    });
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(0);
    expect(pendingRows().length).toBe(0);
  });

  test("empty counts batch is a no-op", () => {
    expect(recordAuthFallbackCounts(1000, 2000, [])).toBe(0);
    expect(pendingRows().length).toBe(0);
  });

  test("returns 0 when the telemetry DB is unavailable", () => {
    const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
    try {
      expect(recordAuthFallbackCounts(1000, 2000, SAMPLE)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(pendingRows().length).toBe(0);
  });

  test("returns the partial count when the telemetry DB vanishes mid-batch", () => {
    const realDb = dbConnection.getTelemetryDb();
    // Call order: the store's own upfront check, then one call per insert.
    // Let the check and the first insert see the DB, then lose it.
    const spy = spyOn(dbConnection, "getTelemetryDb")
      .mockReturnValueOnce(realDb)
      .mockReturnValueOnce(realDb)
      .mockReturnValue(null);
    try {
      expect(recordAuthFallbackCounts(1000, 2000, SAMPLE)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const payloads = pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0].guard).toBe("edge");
  });
});
