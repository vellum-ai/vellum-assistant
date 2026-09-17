/**
 * Migration 382 creates `client_connection_events`, the durable hub
 * subscribe/dispose ledger used by `assistant clients history`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateClientConnectionEvents } from "../382-create-client-connection-events.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function tableNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function indexNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrateCreateClientConnectionEvents", () => {
  test("creates the table and its lookup indexes", () => {
    const db = createTestDb();

    migrateCreateClientConnectionEvents(db);

    expect(tableNames(db)).toContain("client_connection_events");
    expect(indexNames(db)).toContain(
      "idx_client_connection_events_client_occurred",
    );
    expect(indexNames(db)).toContain("idx_client_connection_events_occurred");
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateCreateClientConnectionEvents(db);
    migrateCreateClientConnectionEvents(db);

    expect(tableNames(db)).toContain("client_connection_events");
  });
});
