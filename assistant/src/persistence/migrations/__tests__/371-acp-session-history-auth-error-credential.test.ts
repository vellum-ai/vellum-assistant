/**
 * Migration 371 adds the nullable `auth_error_credential` column that names
 * which Claude token a run's credential failure was refused on, and is
 * idempotent so a repair flow can re-run it.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateAcpSessionHistoryAuthErrorCredential } from "../371-acp-session-history-auth-error-credential.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec(
    "CREATE TABLE acp_session_history (id TEXT PRIMARY KEY, status TEXT)",
  );
  return drizzle(sqlite, { schema });
}

function columnNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("PRAGMA table_info(acp_session_history)")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migrateAcpSessionHistoryAuthErrorCredential", () => {
  test("adds the column when it is missing", () => {
    const db = createTestDb();

    migrateAcpSessionHistoryAuthErrorCredential(db);

    expect(columnNames(db)).toContain("auth_error_credential");
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateAcpSessionHistoryAuthErrorCredential(db);
    migrateAcpSessionHistoryAuthErrorCredential(db);

    expect(columnNames(db)).toContain("auth_error_credential");
  });

  test("leaves existing rows null, which reads as a marker worth serving", () => {
    // A row marked before this column existed names no credential. The
    // comparison treats that as no evidence the failure was repaired and
    // serves the marker, so an upgrade cannot silently swallow a card.
    const db = createTestDb();
    getSqliteFrom(db).exec(
      "INSERT INTO acp_session_history (id, status) VALUES ('run-1', 'failed')",
    );

    migrateAcpSessionHistoryAuthErrorCredential(db);

    const row = getSqliteFrom(db)
      .prepare(
        "SELECT auth_error_credential FROM acp_session_history WHERE id = 'run-1'",
      )
      .get() as { auth_error_credential: string | null };
    expect(row.auth_error_credential).toBeNull();
  });
});
