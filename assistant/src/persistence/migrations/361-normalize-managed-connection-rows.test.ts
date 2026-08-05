import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateNormalizeManagedConnectionRows } from "./361-normalize-managed-connection-rows.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE provider_connections (
      name        TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT,
      base_url    TEXT,
      models      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertRow(
  sqlite: Database,
  name: string,
  provider: string,
  auth: string,
): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`,
    )
    .run(name, provider, auth);
}

function readRows(
  sqlite: Database,
): Array<{ name: string; provider: string; auth: string }> {
  return sqlite
    .query(
      `SELECT name, provider, auth FROM provider_connections ORDER BY name`,
    )
    .all() as Array<{ name: string; provider: string; auth: string }>;
}

function readRow(
  sqlite: Database,
  name: string,
): { provider: string; auth: string } {
  const row = readRows(sqlite).find((r) => r.name === name);
  if (!row) {
    throw new Error(`row "${name}" not found`);
  }
  return row;
}

describe("migration 361: normalize managed connection rows", () => {
  test("rewrites a platform-auth row with a concrete provider to provider vellum", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "managed-openai", "openai", '{"type":"platform"}');

    migrateNormalizeManagedConnectionRows(db);

    const row = readRow(sqlite, "managed-openai");
    expect(row.provider).toBe("vellum");
    expect(JSON.parse(row.auth)).toEqual({ type: "platform" });
  });

  test("heals a stuck legacy canonical row (name vellum, concrete provider, platform auth)", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "vellum", "anthropic", '{"type":"platform"}');

    migrateNormalizeManagedConnectionRows(db);

    expect(readRow(sqlite, "vellum").provider).toBe("vellum");
  });

  test("rewrites a vellum-provider row with non-platform auth to platform auth", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "keyed-vellum",
      "vellum",
      '{"type":"api_key","credential":"vault/x"}',
    );
    insertRow(sqlite, "none-vellum", "vellum", '{"type":"none"}');

    migrateNormalizeManagedConnectionRows(db);

    expect(JSON.parse(readRow(sqlite, "keyed-vellum").auth)).toEqual({
      type: "platform",
    });
    expect(JSON.parse(readRow(sqlite, "none-vellum").auth)).toEqual({
      type: "platform",
    });
  });

  test("leaves consistent rows untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "vellum", "vellum", '{"type":"platform"}');
    insertRow(
      sqlite,
      "anthropic-key",
      "anthropic",
      '{"type":"api_key","credential":"vault/anthropic"}',
    );
    insertRow(
      sqlite,
      "chatgpt-subscription",
      "openai",
      '{"type":"oauth_subscription"}',
    );
    insertRow(sqlite, "ollama-local", "ollama", '{"type":"none"}');

    const before = readRows(sqlite);
    migrateNormalizeManagedConnectionRows(db);

    expect(readRows(sqlite)).toEqual(before);
  });

  test("leaves a BYOK row claiming the canonical name untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "vellum",
      "anthropic",
      '{"type":"api_key","credential":"vault/anthropic"}',
    );

    migrateNormalizeManagedConnectionRows(db);

    const row = readRow(sqlite, "vellum");
    expect(row.provider).toBe("anthropic");
    expect(JSON.parse(row.auth).type).toBe("api_key");
  });

  test("leaves a row with unparseable auth untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "broken", "vellum", "not json");

    migrateNormalizeManagedConnectionRows(db);

    expect(readRow(sqlite, "broken").auth).toBe("not json");
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "managed-openai", "openai", '{"type":"platform"}');
    insertRow(sqlite, "keyed-vellum", "vellum", '{"type":"api_key"}');

    migrateNormalizeManagedConnectionRows(db);
    const afterFirst = readRows(sqlite);
    migrateNormalizeManagedConnectionRows(db);

    expect(readRows(sqlite)).toEqual(afterFirst);
  });

  test("no-ops on a database from before the provider_connections table", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });

    expect(() => migrateNormalizeManagedConnectionRows(db)).not.toThrow();
  });
});
