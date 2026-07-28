/**
 * Tests for {@link rawTelemetryRun} — the raw-write helper for the dedicated
 * telemetry connection (`assistant-telemetry.db`), mirroring
 * `rawMemoryRun`/`rawLogsRun`. Writes must land on the telemetry connection,
 * not the main DB, and return the changed-row count.
 */

import { describe, expect, test } from "bun:test";

import { getSqlite, getTelemetrySqlite } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { rawTelemetryRun } from "../raw-query.js";

await initializeDb();

const telemetry = getTelemetrySqlite();
if (!telemetry) throw new Error("telemetry database unavailable in test");

telemetry.exec(/*sql*/ `
  CREATE TABLE IF NOT EXISTS raw_telemetry_run_test (
    id TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )
`);

describe("rawTelemetryRun", () => {
  test("inserts on the telemetry connection and returns the changed-row count", () => {
    const changes = rawTelemetryRun(
      "test:insert",
      "INSERT INTO raw_telemetry_run_test (id, value) VALUES (?, ?)",
      "row-1",
      42,
    );
    expect(changes).toBe(1);

    // The row is visible through the telemetry connection…
    const row = telemetry
      .query("SELECT id, value FROM raw_telemetry_run_test WHERE id = ?")
      .get("row-1");
    expect(row).toEqual({ id: "row-1", value: 42 });

    // …and the table does not exist on the main connection at all.
    const onMain = getSqlite()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("raw_telemetry_run_test");
    expect(onMain).toBeNull();
  });

  test("delete returns the changed-row count", () => {
    rawTelemetryRun(
      "test:insert",
      "INSERT INTO raw_telemetry_run_test (id, value) VALUES (?, ?), (?, ?)",
      "row-2",
      1,
      "row-3",
      2,
    );

    const deleted = rawTelemetryRun(
      "test:delete",
      "DELETE FROM raw_telemetry_run_test WHERE id IN (?, ?)",
      "row-2",
      "row-3",
    );
    expect(deleted).toBe(2);

    const noMatch = rawTelemetryRun(
      "test:delete",
      "DELETE FROM raw_telemetry_run_test WHERE id = ?",
      "missing",
    );
    expect(noMatch).toBe(0);
  });
});
