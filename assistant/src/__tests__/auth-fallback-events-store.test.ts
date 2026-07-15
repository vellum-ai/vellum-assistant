import { beforeEach, describe, expect, test } from "bun:test";

import {
  type AuthFallbackCount,
  recordAuthFallbackCounts,
} from "../security/auth-fallback-events-store.js";
import {
  pendingOutboxRows,
  resetOutboxTable,
  setShareAnalytics,
  withTelemetryDbUnavailable,
} from "../telemetry/__tests__/outbox-test-harness.js";
import type { AuthFallbackTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

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
    setShareAnalytics(true);
    resetOutboxTable();
  });

  test("records one outbox row per count entry with the full wire payload", () => {
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(2);

    const rows = pendingOutboxRows("auth_fallback");
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
    setShareAnalytics(false);
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(0);
    expect(pendingOutboxRows("auth_fallback").length).toBe(0);
  });

  test("empty counts batch is a no-op", () => {
    expect(recordAuthFallbackCounts(1000, 2000, [])).toBe(0);
    expect(pendingOutboxRows("auth_fallback").length).toBe(0);
  });

  test("records all-or-nothing: db unavailable returns 0 with no rows", () => {
    withTelemetryDbUnavailable(() => {
      expect(recordAuthFallbackCounts(1000, 2000, SAMPLE)).toBe(0);
    });
    // No partial batch: the gateway's `recorded === 0` retry contract means
    // any committed remnant would later double-count.
    expect(pendingOutboxRows("auth_fallback").length).toBe(0);
  });
});
