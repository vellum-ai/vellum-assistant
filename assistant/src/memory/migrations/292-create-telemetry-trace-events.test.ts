import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { createTelemetryTraceEventsTable } from "./292-create-telemetry-trace-events.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(telemetry_trace_events)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA index_list(telemetry_trace_events)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 292: telemetry_trace_events table", () => {
  test("creates the table with the expected columns", () => {
    const { sqlite, db } = createTestDb();

    createTelemetryTraceEventsTable(db);

    expect(columnNames(sqlite)).toEqual([
      "id",
      "created_at",
      "conversation_id",
      "request_id",
      "turn_index",
      "trace",
    ]);
  });

  test("creates the (created_at, id) cursor index", () => {
    const { sqlite, db } = createTestDb();

    createTelemetryTraceEventsTable(db);

    expect(indexNames(sqlite)).toContain(
      "idx_telemetry_trace_events_created_at_id",
    );
    const columns = (
      sqlite
        .query("PRAGMA index_info(idx_telemetry_trace_events_created_at_id)")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["created_at", "id"]);
  });

  test("is idempotent — re-run is a no-op and preserves existing rows", () => {
    const { sqlite, db } = createTestDb();

    createTelemetryTraceEventsTable(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO telemetry_trace_events (id, created_at, conversation_id, trace)
      VALUES ('tte-1', 1000, 'conv-1', '{}')
    `);

    expect(() => createTelemetryTraceEventsTable(db)).not.toThrow();

    const rows = sqlite.query("SELECT id FROM telemetry_trace_events").all();
    expect(rows).toEqual([{ id: "tte-1" }]);
    expect(
      indexNames(sqlite).filter(
        (name) => name === "idx_telemetry_trace_events_created_at_id",
      ),
    ).toHaveLength(1);
  });
});
