import { mock, spyOn } from "bun:test";

let shareAnalytics = true;

// Installed when this harness is imported. bun's mock.module patches
// retroactively (live bindings), so importers need no special import order.
mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import * as dbConnection from "../../persistence/db-connection.js";
import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { telemetryEvents } from "../../persistence/schema/index.js";
import { queryTelemetryOutboxBatch } from "../telemetry-events-outbox.js";

await initializeDb();

/** Flip the mocked share_analytics consent; call with true in beforeEach. */
export function setShareAnalytics(value: boolean): void {
  shareAnalytics = value;
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
