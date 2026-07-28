import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateProviderConnections } from "../243-provider-connections.js";
import { migrateRemoveLegacyManagedConnections } from "../319-remove-legacy-managed-connections.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function insertConnection(
  db: ReturnType<typeof createTestDb>,
  name: string,
  provider: string,
): void {
  const raw = getSqliteFrom(db);
  const now = Date.now();
  raw
    .query(
      `INSERT OR IGNORE INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(name, provider, JSON.stringify({ type: "platform" }), now, now);
}

function connectionNames(db: ReturnType<typeof createTestDb>): string[] {
  return (
    getSqliteFrom(db)
      .query(`SELECT name FROM provider_connections ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

const LEGACY = [
  "anthropic-managed",
  "openai-managed",
  "gemini-managed",
  "fireworks-managed",
  "together-managed",
];

describe("migration 319 — remove legacy *-managed connections", () => {
  test("deletes all five legacy managed connections", () => {
    const db = createTestDb();
    migrateCreateProviderConnections(db); // seeds anthropic/openai/gemini-managed
    for (const name of LEGACY) {
      insertConnection(db, name, name.replace("-managed", ""));
    }

    migrateRemoveLegacyManagedConnections(db);

    const names = connectionNames(db);
    for (const legacy of LEGACY) {
      expect(names).not.toContain(legacy);
    }
  });

  test("leaves the vellum connection and personal connections untouched", () => {
    const db = createTestDb();
    migrateCreateProviderConnections(db);
    insertConnection(db, "vellum", "vellum");
    insertConnection(db, "anthropic-personal", "anthropic");

    migrateRemoveLegacyManagedConnections(db);

    const names = connectionNames(db);
    expect(names).toContain("vellum");
    expect(names).toContain("anthropic-personal");
  });

  test("is idempotent — second run is a no-op", () => {
    const db = createTestDb();
    migrateCreateProviderConnections(db);
    migrateRemoveLegacyManagedConnections(db);
    expect(() => migrateRemoveLegacyManagedConnections(db)).not.toThrow();
  });

  test("no-op when provider_connections table is absent", () => {
    const db = createTestDb();
    expect(() => migrateRemoveLegacyManagedConnections(db)).not.toThrow();
  });
});
