/**
 * Tests for migration 297 — moving `llm_request_logs` into the attached
 * `logs` database.
 *
 * Covers:
 *   1. End state after a full initializeDb(): the table lives in `logs`, not
 *      `main`, and the Drizzle store round-trips against it.
 *   2. The data move itself: legacy rows in a `main.llm_request_logs` are
 *      copied into `logs` and the main-DB copy is dropped, with indexes built
 *      in `logs`.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, LOGS_DB_SCHEMA } =
  await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateMoveLlmRequestLogsToLogsDb } =
  await import("../297-move-llm-request-logs-to-logs-db.js");
const { recordRequestLog, getRequestLogById } =
  await import("../../llm-request-log-store.js");

initializeDb();

const CHECKPOINT_KEY = "migration_move_llm_request_logs_to_logs_db_v1";

function tableSchemas(name: string): string[] {
  return getSqlite()
    .query<{ schema: string }, []>(
      `SELECT 'main' AS schema FROM main.sqlite_master WHERE type='table' AND name='${name}'
       UNION ALL
       SELECT '${LOGS_DB_SCHEMA}' FROM ${LOGS_DB_SCHEMA}.sqlite_master WHERE type='table' AND name='${name}'`,
    )
    .all()
    .map((r) => r.schema);
}

describe("migration 297 — llm_request_logs lives in the logs database", () => {
  test("after init, the table is in logs and not in main", () => {
    expect(tableSchemas("llm_request_logs")).toEqual([LOGS_DB_SCHEMA]);
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
    const inLogs = getSqlite()
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM ${LOGS_DB_SCHEMA}.llm_request_logs WHERE id = ?`)
      .get(id);
    expect(inLogs?.c).toBe(1);
  });

  test("moves legacy rows from a main-DB table and drops it", () => {
    const sqlite = getSqlite();

    // Simulate a pre-move database: legacy table + row in main, no logs copy,
    // checkpoint cleared so withCrashRecovery runs the body.
    sqlite.exec(`DROP TABLE IF EXISTS ${LOGS_DB_SCHEMA}.llm_request_logs`);
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
    sqlite.exec(
      `DELETE FROM memory_checkpoints WHERE key = '${CHECKPOINT_KEY}'`,
    );

    migrateMoveLlmRequestLogsToLogsDb(getDb());

    // Main copy gone, logs copy has the row.
    expect(tableSchemas("llm_request_logs")).toEqual([LOGS_DB_SCHEMA]);
    const moved = sqlite
      .query<
        { conversation_id: string; provider: string },
        []
      >(`SELECT conversation_id, provider FROM ${LOGS_DB_SCHEMA}.llm_request_logs WHERE id = 'legacy-1'`)
      .get();
    expect(moved?.conversation_id).toBe("conv-legacy");
    expect(moved?.provider).toBe("openai");

    // Indexes were created in the logs database.
    const indexes = sqlite
      .query<{ name: string }, []>(
        `SELECT name FROM ${LOGS_DB_SCHEMA}.sqlite_master WHERE type='index' AND tbl_name='llm_request_logs'`,
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_llm_request_logs_message_id");
    expect(indexes).toContain("idx_llm_request_logs_created_at");
    expect(indexes).toContain("idx_llm_request_logs_conv_created");

    // Checkpoint recorded so the move won't re-run.
    const ckpt = sqlite
      .query<
        { value: string },
        []
      >(`SELECT value FROM memory_checkpoints WHERE key = '${CHECKPOINT_KEY}'`)
      .get();
    expect(ckpt?.value).toBe("1");
  });
});
