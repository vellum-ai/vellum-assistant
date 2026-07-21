/**
 * Tests for migration 333: creating the generic `telemetry_events` outbox
 * table on the dedicated telemetry database (`assistant-telemetry.db`).
 *
 * Runs against real workspace databases (`initializeDb()` already ran the
 * step once), so the tests assert the resulting telemetry-side schema and
 * that re-running the step is idempotent.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getTelemetrySqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateCreateTelemetryEventsTable } =
  await import("./333-create-telemetry-events-table.js");

await initializeDb();

function telemetryTableExists(name: string): boolean {
  return (
    getTelemetrySqlite()!
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function telemetryIndexNames(): string[] {
  return (
    getTelemetrySqlite()!
      .query(`PRAGMA index_list(telemetry_events)`)
      .all() as Array<{ name: string }>
  ).map((i) => i.name);
}

describe("migration 333: create telemetry_events on the telemetry DB", () => {
  test("initializeDb created the table with both indexes", () => {
    expect(telemetryTableExists("telemetry_events")).toBe(true);
    const indexes = telemetryIndexNames();
    expect(indexes).toContain("idx_telemetry_events_name_created_at_id");
    expect(indexes).toContain("idx_telemetry_events_conversation_id");
  });

  test("re-running the step is idempotent and preserves existing rows", () => {
    const telemetry = getTelemetrySqlite()!;
    telemetry.exec(`DELETE FROM telemetry_events`);
    telemetry.exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('row-1', 'lifecycle', 1000, NULL, '{"type":"lifecycle"}')`,
    );

    migrateCreateTelemetryEventsTable(getDb());

    expect(telemetryTableExists("telemetry_events")).toBe(true);
    const indexes = telemetryIndexNames();
    expect(indexes).toContain("idx_telemetry_events_name_created_at_id");
    expect(indexes).toContain("idx_telemetry_events_conversation_id");
    const row = telemetry
      .query(`SELECT id, name, payload FROM telemetry_events`)
      .get();
    expect(row).toEqual({
      id: "row-1",
      name: "lifecycle",
      payload: '{"type":"lifecycle"}',
    });
    telemetry.exec(`DELETE FROM telemetry_events`);
  });
});
