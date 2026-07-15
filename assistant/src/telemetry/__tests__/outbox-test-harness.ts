import { mock, spyOn } from "bun:test";

import type { ConsentState } from "../../platform/consent-cache.js";

let shareAnalytics: ConsentState = true;
// Owner's `share_diagnostics` consent + accepted version — a second,
// independent gate some outbox event types layer on top of
// `share_analytics` (their payload carries content richer than metadata).
// Default permissive/far-future so tests that only care about the analytics
// gate are unaffected; the diagnostics-specific cases override via
// `setShareDiagnostics`.
let shareDiagnostics = true;
let shareDiagnosticsVersion = "2999-01-01";

// Installed when this harness is imported. bun's mock.module patches
// retroactively (live bindings), so importers need no special import order.
// This harness is imported by *.test.ts files only — never by the test
// preload — so it runs after the per-test workspace override, where src/
// imports are as safe as in the test files themselves (AGENTS.md "Test
// machinery isolation" scopes its no-src/ rule to preload-time machinery).
mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics === true,
  getRawShareAnalytics: () => shareAnalytics,
  getCachedShareDiagnostics: () => shareDiagnostics,
  getCachedShareDiagnosticsVersion: () => shareDiagnosticsVersion,
}));

import * as dbConnection from "../../persistence/db-connection.js";
import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { telemetryEvents } from "../../persistence/schema/index.js";
import { queryTelemetryOutboxBatch } from "../telemetry-events-outbox.js";

await initializeDb();

/** Flip the mocked share_analytics consent; call with true in beforeEach. */
export function setShareAnalytics(value: ConsentState): void {
  shareAnalytics = value;
}

/**
 * Flip the mocked share_diagnostics consent and, optionally, its accepted
 * version (defaults far-future/unconditionally eligible). Call with `true`
 * in `beforeEach` for stores that gate on it.
 */
export function setShareDiagnostics(
  value: boolean,
  version = "2999-01-01",
): void {
  shareDiagnostics = value;
  shareDiagnosticsVersion = version;
}

/** Delete every telemetry_events row. */
export function resetOutboxTable(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(telemetryEvents).run();
}

/** Pending rows for one event name in (created_at, id) order. */
export function pendingOutboxRows(name: string, limit = 100) {
  return queryTelemetryOutboxBatch(name, limit);
}

/** Pending payloads for one event name, JSON-parsed, in flush order. */
export function pendingOutboxPayloads<T = Record<string, unknown>>(
  name: string,
  limit = 100,
): T[] {
  return pendingOutboxRows(name, limit).map(
    (row) => JSON.parse(row.payload) as T,
  );
}

/** Run `fn` with the telemetry connection reported as unavailable. */
export function withTelemetryDbUnavailable(fn: () => void): void {
  const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}
