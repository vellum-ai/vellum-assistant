/**
 * Tests for migration 265 (`compaction_logs` table). The table is
 * created via idempotent `CREATE TABLE IF NOT EXISTS` + index DDL — re-
 * running the migration must be a no-op once the table exists.
 *
 * Modeled on `db-llm-request-log-provider-migration.test.ts` and the
 * idempotency block of `llm-request-log-call-site.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { migrateCompactionLogs } from "../memory/migrations/265-compaction-logs.js";

initializeDb();

describe("migrateCompactionLogs", () => {
  test("creates the compaction_logs table when missing", () => {
    const db = getDb();
    const raw = getSqliteFrom(db);

    // Drop the table to simulate a pre-265 install.
    raw.exec(`DROP TABLE IF EXISTS compaction_logs`);

    const beforeTables = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_logs'`,
      )
      .all() as Array<{ name: string }>;
    expect(beforeTables.length).toBe(0);

    migrateCompactionLogs(db);

    const afterTables = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_logs'`,
      )
      .all() as Array<{ name: string }>;
    expect(afterTables.length).toBe(1);
  });

  test("creates expected columns", () => {
    const db = getDb();
    const raw = getSqliteFrom(db);
    raw.exec(`DROP TABLE IF EXISTS compaction_logs`);
    migrateCompactionLogs(db);

    const columns = raw
      .query(`PRAGMA table_info(compaction_logs)`)
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(columns.map((c) => [c.name, c]));

    // Spot-check the columns the rest of the system depends on. Full
    // schema review lives in the Drizzle definition + migration file.
    expect(byName.has("id")).toBe(true);
    expect(byName.has("conversation_id")).toBe(true);
    expect(byName.has("llm_request_log_id")).toBe(true);
    expect(byName.has("mode")).toBe(true);
    expect(byName.has("outcome")).toBe(true);
    expect(byName.has("before_message_count")).toBe(true);
    expect(byName.has("after_message_count")).toBe(true);
    expect(byName.has("before_estimated_tokens")).toBe(true);
    expect(byName.has("after_estimated_tokens")).toBe(true);
    expect(byName.has("summary_input_tokens")).toBe(true);
    expect(byName.has("summary_output_tokens")).toBe(true);
    expect(byName.has("model")).toBe(true);
    expect(byName.has("latency_ms")).toBe(true);
    expect(byName.has("error_message")).toBe(true);
    expect(byName.has("summary_excerpt")).toBe(true);
    expect(byName.has("created_at")).toBe(true);

    // NOT NULL columns — fields the row contract requires.
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("mode")?.notnull).toBe(1);
    expect(byName.get("outcome")?.notnull).toBe(1);
    expect(byName.get("created_at")?.notnull).toBe(1);
    // llm_request_log_id is intentionally nullable — see schema comment.
    expect(byName.get("llm_request_log_id")?.notnull).toBe(0);
  });

  test("creates conversation + created_at indexes", () => {
    const db = getDb();
    const raw = getSqliteFrom(db);
    raw.exec(`DROP TABLE IF EXISTS compaction_logs`);
    migrateCompactionLogs(db);

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='compaction_logs'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));

    expect(names.has("idx_compaction_logs_conversation")).toBe(true);
    expect(names.has("idx_compaction_logs_created_at")).toBe(true);
  });

  test("is idempotent — second run is a no-op", () => {
    const db = getDb();
    migrateCompactionLogs(db);
    expect(() => migrateCompactionLogs(db)).not.toThrow();
  });
});
