import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateOAuthProvidersResponseOkField } from "./379-oauth-providers-response-ok-field.js";

function createTestDb(options: { withTable?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  if (options.withTable !== false) {
    // Pre-379 shape: only the columns the migration and tests touch.
    sqlite.exec(/*sql*/ `
      CREATE TABLE oauth_providers (
        provider_key TEXT PRIMARY KEY,
        identity_ok_field TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(oauth_providers)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("migration 379: oauth_providers.response_ok_field", () => {
  test("adds the nullable column beside the identity one", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("response_ok_field");

    migrateOAuthProvidersResponseOkField(db);

    const column = (
      sqlite.query("PRAGMA table_info(oauth_providers)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === "response_ok_field");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    expect(columnNames(sqlite)).toContain("identity_ok_field");
  });

  test("rows written before the column existed read back null", () => {
    // A provider that declared nothing is judged by status alone, which is
    // what it was before the column existed.
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO oauth_providers (provider_key, identity_ok_field, created_at, updated_at)
      VALUES ('slack', 'ok', 1000, 1000)
    `);

    migrateOAuthProvidersResponseOkField(db);

    const row = sqlite
      .query(
        "SELECT response_ok_field FROM oauth_providers WHERE provider_key = 'slack'",
      )
      .get() as { response_ok_field: unknown };
    expect(row.response_ok_field).toBeNull();
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateOAuthProvidersResponseOkField(db);
    expect(() => migrateOAuthProvidersResponseOkField(db)).not.toThrow();

    expect(
      columnNames(sqlite).filter((n) => n === "response_ok_field"),
    ).toHaveLength(1);
  });

  test("a missing table is a failure, never a silent success", () => {
    // The runner checkpoints a throwing step as failed and retries it, and
    // the registry defers this step behind the table's own. Swallowing the
    // error here would checkpoint the step as done against no table, and the
    // column would never be added.
    // The driver wraps SQLite's "no such table" in its own message, so the
    // assertion is that the step throws at all.
    const { db } = createTestDb({ withTable: false });

    expect(() => migrateOAuthProvidersResponseOkField(db)).toThrow();
  });
});
