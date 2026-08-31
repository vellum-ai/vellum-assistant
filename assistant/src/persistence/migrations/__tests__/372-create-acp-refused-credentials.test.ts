/**
 * Migration 372 creates `acp_refused_credentials`, the record of which Claude
 * tokens Claude has refused. It is separate from the session-history marker so
 * that clearing session history cannot change which credential a spawn picks.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateAcpRefusedCredentials } from "../372-create-acp-refused-credentials.js";

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

describe("migrateCreateAcpRefusedCredentials", () => {
  test("creates the table", () => {
    const db = createTestDb();

    migrateCreateAcpRefusedCredentials(db);

    expect(tableNames(db)).toContain("acp_refused_credentials");
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateCreateAcpRefusedCredentials(db);
    migrateCreateAcpRefusedCredentials(db);

    expect(tableNames(db)).toContain("acp_refused_credentials");
  });

  test("keeps one row per digest, so a retried refusal is not an error", () => {
    const db = createTestDb();
    migrateCreateAcpRefusedCredentials(db);
    const raw = getSqliteFrom(db);

    raw.exec(
      "INSERT OR IGNORE INTO acp_refused_credentials (digest, refused_at) VALUES ('abc', 1)",
    );
    raw.exec(
      "INSERT OR IGNORE INTO acp_refused_credentials (digest, refused_at) VALUES ('abc', 2)",
    );

    const rows = raw
      .prepare("SELECT digest, refused_at FROM acp_refused_credentials")
      .all() as { digest: string; refused_at: number }[];
    expect(rows).toEqual([{ digest: "abc", refused_at: 1 }]);
  });
});
