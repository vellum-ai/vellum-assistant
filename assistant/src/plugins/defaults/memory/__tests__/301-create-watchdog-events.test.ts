import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// The migration opens the telemetry connection via getTelemetrySqlite(), which
// routes through the singleton. Mock the path helper so the connection opens a
// temp file we control, then mock the db-connection getter so it returns that
// same file's Database.
const tmpDir = mkdtempSync(join(tmpdir(), "wd-migration-"));
const telemetryPath = join(tmpDir, "assistant-telemetry.db");
let openedRaw: Database | null = null;

mock.module("../../../../util/telemetry-db-path.js", () => ({
  getTelemetryDbPath: () => telemetryPath,
}));

mock.module("../../../../persistence/db-connection.js", () => ({
  // The migration calls getTelemetrySqlite(); return our temp Database so the
  // DDL runs against it. getSqliteFrom is used in other contexts but not by
  // this migration when the mock is active.
  getTelemetrySqlite: () => openedRaw,
  getSqliteFrom: (db: unknown) =>
    (db as unknown as { $client: Database }).$client,
}));

import { createWatchdogEventsTable } from "../../../../persistence/migrations/301-create-watchdog-events.js";
import * as schema from "../../../../persistence/schema/index.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function openTelemetryRaw(): Database {
  openedRaw = new Database(telemetryPath);
  return openedRaw;
}

function columnNames(raw: Database): string[] {
  return (
    raw.query("PRAGMA table_info(watchdog_events)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

function indexNames(raw: Database): string[] {
  return (
    raw.query("PRAGMA index_list(watchdog_events)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 300: watchdog_events table on telemetry DB", () => {
  test("creates the table with the expected columns", () => {
    const raw = openTelemetryRaw();
    const { db } = createTestDb();

    createWatchdogEventsTable(db);

    expect(columnNames(raw)).toEqual([
      "id",
      "created_at",
      "check_name",
      "value",
      "detail",
    ]);
  });

  test("creates the (created_at, id) cursor index", () => {
    const raw = openTelemetryRaw();
    const { db } = createTestDb();

    createWatchdogEventsTable(db);

    expect(indexNames(raw)).toContain("idx_watchdog_events_created_at_id");
    const columns = (
      raw
        .query("PRAGMA index_info(idx_watchdog_events_created_at_id)")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["created_at", "id"]);
  });

  test("is idempotent — re-run is a no-op and preserves existing rows", () => {
    const raw = openTelemetryRaw();
    const { db } = createTestDb();

    createWatchdogEventsTable(db);
    raw.exec(/*sql*/ `
      INSERT INTO watchdog_events (id, created_at, check_name, value)
      VALUES ('wd-1', 1000, 'event_loop_blocked', 60000)
    `);

    expect(() => createWatchdogEventsTable(db)).not.toThrow();

    const rows = raw.query("SELECT id FROM watchdog_events").all();
    expect(rows).toEqual([{ id: "wd-1" }]);
    expect(
      indexNames(raw).filter(
        (name) => name === "idx_watchdog_events_created_at_id",
      ),
    ).toHaveLength(1);
  });
});
