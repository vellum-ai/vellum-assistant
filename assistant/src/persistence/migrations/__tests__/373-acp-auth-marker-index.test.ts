/**
 * Migration 373 indexes a conversation's credential-failure markers, which is
 * the query every snapshot refetch runs.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateAcpAuthMarkerIndex } from "../373-acp-auth-marker-index.js";

const MARKER_QUERY = `
  SELECT agent_id FROM acp_session_history
  WHERE parent_conversation_id = 'conv-1' AND auth_error_code IS NOT NULL
  ORDER BY started_at DESC LIMIT 20
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec(
    `CREATE TABLE acp_session_history (
       id TEXT PRIMARY KEY,
       agent_id TEXT,
       parent_conversation_id TEXT,
       started_at INTEGER,
       auth_error_code TEXT
     )`,
  );
  return drizzle(sqlite, { schema });
}

function indexNames(db: ReturnType<typeof createTestDb>): string[] {
  const rows = getSqliteFrom(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function queryPlan(db: ReturnType<typeof createTestDb>): string {
  const rows = getSqliteFrom(db)
    .prepare(`EXPLAIN QUERY PLAN ${MARKER_QUERY}`)
    .all() as { detail: string }[];
  return rows.map((row) => row.detail).join(" | ");
}

describe("migrateAcpAuthMarkerIndex", () => {
  test("creates the index", () => {
    const db = createTestDb();

    migrateAcpAuthMarkerIndex(db);

    expect(indexNames(db)).toContain("idx_acp_session_history_auth_marker");
  });

  test("re-running is a no-op", () => {
    const db = createTestDb();

    migrateAcpAuthMarkerIndex(db);
    migrateAcpAuthMarkerIndex(db);

    expect(indexNames(db)).toContain("idx_acp_session_history_auth_marker");
  });

  test("the marker lookup uses it, and stops sorting to answer", () => {
    // The point of the index, not merely its existence. Without it the planner
    // gathers the conversation's rows and sorts them, which is work that grows
    // with how many runs it has had rather than with the few the answer needs.
    const db = createTestDb();
    const before = queryPlan(db);

    migrateAcpAuthMarkerIndex(db);

    const after = queryPlan(db);
    expect(before).toContain("SCAN");
    expect(after).toContain("idx_acp_session_history_auth_marker");
    expect(after).not.toContain("TEMP B-TREE");
  });
});
