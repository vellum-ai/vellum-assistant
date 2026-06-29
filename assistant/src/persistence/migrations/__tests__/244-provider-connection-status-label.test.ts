import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateProviderConnections } from "../243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../244-provider-connection-status-label.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

describe("migration 244 — provider_connection status + label", () => {
  test("adds status (NOT NULL DEFAULT active) and label (nullable) columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    // Bootstrap provider_connections table via migration 243.
    migrateCreateProviderConnections(db);

    // Verify the new columns are absent before migration 244.
    const colsBefore = raw
      .query(`PRAGMA table_info(provider_connections)`)
      .all() as ColumnRow[];
    const namesBefore = colsBefore.map((c) => c.name);
    expect(namesBefore).not.toContain("status");
    expect(namesBefore).not.toContain("label");

    migrateProviderConnectionStatusLabel(db);

    const cols = raw
      .query(`PRAGMA table_info(provider_connections)`)
      .all() as ColumnRow[];
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    // status: NOT NULL, default 'active'
    expect(colMap["status"]).toBeDefined();
    expect(colMap["status"].notnull).toBe(1);
    expect(colMap["status"].dflt_value).toBe("'active'");

    // label: nullable
    expect(colMap["label"]).toBeDefined();
    expect(colMap["label"].notnull).toBe(0);
    expect(colMap["label"].dflt_value).toBeNull();
  });

  test("is idempotent — running twice does not throw", () => {
    const db = createTestDb();
    migrateCreateProviderConnections(db);
    migrateProviderConnectionStatusLabel(db);
    expect(() => migrateProviderConnectionStatusLabel(db)).not.toThrow();
  });

  test("existing rows get status=active from column default", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    // Seed a row before adding the status column.
    migrateCreateProviderConnections(db);

    // Verify canonical connections got the default.
    migrateProviderConnectionStatusLabel(db);

    const rows = raw
      .query(`SELECT name, status, label FROM provider_connections`)
      .all() as Array<{
      name: string;
      status: string;
      label: string | null;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.label).toBeNull();
    }
  });
});
