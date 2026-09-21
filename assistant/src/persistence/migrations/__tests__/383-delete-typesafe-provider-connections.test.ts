/**
 * Migration 383 removes `provider_connections` rows for the TypeSafe
 * provider, which moved to the classification family.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateDeleteTypesafeProviderConnections } from "../383-delete-typesafe-provider-connections.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite, { schema });
}

function seed(db: ReturnType<typeof createTestDb>): void {
  const raw = getSqliteFrom(db);
  raw.exec(
    `CREATE TABLE provider_connections (name TEXT PRIMARY KEY, provider TEXT NOT NULL, auth TEXT NOT NULL, updated_at INTEGER)`,
  );
  raw
    .prepare(
      `INSERT INTO provider_connections (name, provider, auth) VALUES (?, ?, ?)`,
    )
    .run("typesafe-personal", "typesafe", JSON.stringify({ type: "api_key" }));
  raw
    .prepare(
      `INSERT INTO provider_connections (name, provider, auth) VALUES (?, ?, ?)`,
    )
    .run(
      "anthropic-personal",
      "anthropic",
      JSON.stringify({ type: "api_key" }),
    );
}

function providers(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db)
      .prepare(`SELECT provider FROM provider_connections ORDER BY provider`)
      .all() as { provider: string }[]
  ).map((row) => row.provider);
}

describe("migrateDeleteTypesafeProviderConnections", () => {
  test("deletes only the typesafe rows", () => {
    const db = createTestDb();
    seed(db);

    migrateDeleteTypesafeProviderConnections(db);

    expect(providers(db)).toEqual(["anthropic"]);
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();
    seed(db);

    migrateDeleteTypesafeProviderConnections(db);
    migrateDeleteTypesafeProviderConnections(db);

    expect(providers(db)).toEqual(["anthropic"]);
  });

  test("tolerates a database without the table", () => {
    const db = createTestDb();

    expect(() => migrateDeleteTypesafeProviderConnections(db)).not.toThrow();
  });
});
