import { beforeEach, describe, expect, mock, test } from "bun:test";

let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { authFallbackEvents } from "../persistence/schema/index.js";
import {
  type AuthFallbackCount,
  queryUnreportedAuthFallbackEvents,
  recordAuthFallbackCounts,
} from "../security/auth-fallback-events-store.js";

await initializeDb();

function resetTable(): void {
  getTelemetryDb()!.delete(authFallbackEvents).run();
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
    resetTable();
  });

  test("records one row per count entry and they are queryable", () => {
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(2);

    const rows = queryUnreportedAuthFallbackEvents(0, undefined, 100);
    expect(rows.length).toBe(2);
    const byGuard = Object.fromEntries(rows.map((r) => [r.guard, r]));
    expect(byGuard["edge"]).toMatchObject({
      path: "/v1/messages",
      failureKind: "missing_authorization",
      count: 7,
      windowStart: 1000,
      windowEnd: 2000,
    });
    expect(byGuard["edge-scoped"]).toMatchObject({
      path: "/v1/files",
      failureKind: "insufficient_scope",
      count: 2,
    });
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    const recorded = recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(0);
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 100).length).toBe(0);
  });

  test("empty counts batch is a no-op", () => {
    expect(recordAuthFallbackCounts(1000, 2000, [])).toBe(0);
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 100).length).toBe(0);
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    recordAuthFallbackCounts(1000, 2000, SAMPLE);
    const all = queryUnreportedAuthFallbackEvents(0, undefined, 100);
    expect(all.length).toBe(2);

    // All rows share the same createdAt (one insert batch). Paginating with a
    // limit of 1 must use the id tiebreaker to make forward progress, not loop.
    const first = queryUnreportedAuthFallbackEvents(0, undefined, 1);
    expect(first.length).toBe(1);
    const second = queryUnreportedAuthFallbackEvents(
      first[0].createdAt,
      first[0].id,
      1,
    );
    expect(second.length).toBe(1);
    expect(second[0].id).not.toBe(first[0].id);

    // Cursor past the last row returns nothing.
    const last = all[all.length - 1];
    expect(
      queryUnreportedAuthFallbackEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });
});
