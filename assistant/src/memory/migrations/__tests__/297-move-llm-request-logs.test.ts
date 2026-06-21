/**
 * Tests for migration 297 — housing `llm_request_logs` in the dedicated
 * `logs` database connection.
 *
 * Covers:
 *   1. End state after a full initializeDb(): the table lives in the logs
 *      connection, not `main`, and the Drizzle store round-trips against it.
 *   2. The relocation itself: rows in a `main.llm_request_logs` are copied into
 *      the logs connection and the main-DB copy is dropped, with indexes built
 *      in the logs connection.
 *   3. A legacy base-only `main` table (predating the newer columns) is copied
 *      without error, NULL-filling the absent columns.
 *
 * The step is idempotent and not checkpoint-gated, so each test can drive it
 * directly without clearing any checkpoint.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getLogsSqlite } =
  await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateMoveLlmRequestLogsToLogsDb } =
  await import("../297-move-llm-request-logs-to-logs-db.js");
const { recordRequestLog, getRequestLogById } =
  await import("../../llm-request-log-store.js");

await initializeDb();

function existsInMain(name: string): boolean {
  return (
    getSqlite()
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

function existsInLogs(name: string): boolean {
  return (
    getLogsSqlite()!
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function stagingExists(table: string): boolean {
  return existsInMain(`${table}__relocating`);
}

describe("migration 297 — llm_request_logs lives in the logs database", () => {
  test("after init, the table is in logs and not in main", () => {
    expect(existsInLogs("llm_request_logs")).toBe(true);
    expect(existsInMain("llm_request_logs")).toBe(false);
  });

  test("the store round-trips against the relocated table", () => {
    const id = recordRequestLog(
      "conv-297",
      JSON.stringify({ req: 1 }),
      JSON.stringify({ res: 1 }),
      "msg-297",
      "anthropic",
      "mainAgent",
    );
    const row = getRequestLogById(id);
    expect(row?.conversationId).toBe("conv-297");
    expect(row?.messageId).toBe("msg-297");
    expect(row?.provider).toBe("anthropic");
    expect(row?.callSite).toBe("mainAgent");

    // The written row physically lives in the logs database.
    const inLogs = getLogsSqlite()!
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM llm_request_logs WHERE id = ?`)
      .get(id);
    expect(inLogs?.c).toBe(1);
  });

  test("relocates rows from a main-DB table and drops it", async () => {
    const sqlite = getSqlite();
    const logs = getLogsSqlite()!;

    // Simulate a populated pre-relocation main-DB table alongside the logs copy.
    logs.exec(`DROP TABLE IF EXISTS llm_request_logs`);
    sqlite.exec(`DROP TABLE IF EXISTS main.llm_request_logs__relocating`);
    sqlite.exec(`
      CREATE TABLE main.llm_request_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        provider TEXT,
        request_payload TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        agent_loop_exit_reason TEXT,
        call_site TEXT
      )
    `);
    sqlite.exec(
      `INSERT INTO main.llm_request_logs (id, conversation_id, request_payload, response_payload, created_at, provider) VALUES ('legacy-1', 'conv-legacy', '{}', '{}', 123, 'openai')`,
    );

    // The migration stages the populated table aside and drains it inline,
    // copying the rows into logs and dropping the staging table before it
    // resolves.
    await migrateMoveLlmRequestLogsToLogsDb(getDb());

    expect(existsInLogs("llm_request_logs")).toBe(true);
    expect(existsInMain("llm_request_logs")).toBe(false);
    expect(stagingExists("llm_request_logs")).toBe(false);
    const moved = logs
      .query<
        { conversation_id: string; provider: string },
        []
      >(`SELECT conversation_id, provider FROM llm_request_logs WHERE id = 'legacy-1'`)
      .get();
    expect(moved?.conversation_id).toBe("conv-legacy");
    expect(moved?.provider).toBe("openai");

    // Indexes were created in the logs database.
    const indexes = logs
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_request_logs'`,
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_llm_request_logs_message_id");
    expect(indexes).toContain("idx_llm_request_logs_created_at");
    expect(indexes).toContain("idx_llm_request_logs_conv_created");
  });

  test("copies a legacy base-only table, NULL-filling newer columns", async () => {
    const sqlite = getSqlite();
    const logs = getLogsSqlite()!;

    // A workspace upgrading from a build that predates the
    // message_id/provider/agent_loop_exit_reason/call_site columns: the main
    // table has only the original base columns.
    logs.exec(`DROP TABLE IF EXISTS llm_request_logs`);
    sqlite.exec(`DROP TABLE IF EXISTS main.llm_request_logs__relocating`);
    sqlite.exec(`
      CREATE TABLE main.llm_request_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    sqlite.exec(
      `INSERT INTO main.llm_request_logs (id, conversation_id, request_payload, response_payload, created_at) VALUES ('base-1', 'conv-base', '{}', '{}', 7)`,
    );

    // Must not throw on the absent columns: the drain NULL-fills them.
    await migrateMoveLlmRequestLogsToLogsDb(getDb());

    expect(existsInLogs("llm_request_logs")).toBe(true);
    expect(existsInMain("llm_request_logs")).toBe(false);
    const moved = logs
      .query<
        {
          conversation_id: string;
          message_id: string | null;
          provider: string | null;
          call_site: string | null;
        },
        []
      >(
        `SELECT conversation_id, message_id, provider, call_site FROM llm_request_logs WHERE id = 'base-1'`,
      )
      .get();
    expect(moved?.conversation_id).toBe("conv-base");
    expect(moved?.message_id).toBeNull();
    expect(moved?.provider).toBeNull();
    expect(moved?.call_site).toBeNull();
  });
});
