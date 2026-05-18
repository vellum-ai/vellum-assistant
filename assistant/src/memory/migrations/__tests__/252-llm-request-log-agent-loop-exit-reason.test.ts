import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateLlmRequestLogAgentLoopExitReason } from "../252-llm-request-log-agent-loop-exit-reason.js";

interface ColumnRow {
  name: string;
  type: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/**
 * Bring the test DB to a state equivalent to a fresh install at
 * migration 251 — `llm_request_logs` table present without the new
 * `agent_loop_exit_reason` column. The table CREATE matches what
 * `createWatchersAndLogsTables` would produce; we don't run the full
 * migration chain here because we only care about the column delta.
 */
function createLlmRequestLogsAt251(
  db: ReturnType<typeof createTestDb>,
): void {
  const raw = getSqliteFrom(db);
  raw.exec(`
    CREATE TABLE llm_request_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      provider TEXT,
      request_payload TEXT NOT NULL,
      response_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function columnsOf(
  db: ReturnType<typeof createTestDb>,
  table: string,
): ColumnRow[] {
  return getSqliteFrom(db)
    .query(`PRAGMA table_info(${table})`)
    .all() as ColumnRow[];
}

describe("migration 252 — llm_request_logs.agent_loop_exit_reason", () => {
  test("adds the column when missing", () => {
    const db = createTestDb();
    createLlmRequestLogsAt251(db);

    expect(
      columnsOf(db, "llm_request_logs").some(
        (c) => c.name === "agent_loop_exit_reason",
      ),
    ).toBe(false);

    migrateLlmRequestLogAgentLoopExitReason(db);

    const col = columnsOf(db, "llm_request_logs").find(
      (c) => c.name === "agent_loop_exit_reason",
    );
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
  });

  test("is a no-op when the column already exists (idempotent)", () => {
    const db = createTestDb();
    createLlmRequestLogsAt251(db);

    migrateLlmRequestLogAgentLoopExitReason(db);
    // Running twice would error out from sqlite if the migration weren't
    // idempotent (`ALTER TABLE … ADD COLUMN` is non-replayable raw SQL).
    expect(() => migrateLlmRequestLogAgentLoopExitReason(db)).not.toThrow();

    const cols = columnsOf(db, "llm_request_logs").filter(
      (c) => c.name === "agent_loop_exit_reason",
    );
    expect(cols).toHaveLength(1);
  });

  test("preserves existing rows; new column defaults to NULL", () => {
    const db = createTestDb();
    createLlmRequestLogsAt251(db);
    const raw = getSqliteFrom(db);
    raw.exec(`
      INSERT INTO llm_request_logs
        (id, conversation_id, message_id, provider, request_payload, response_payload, created_at)
      VALUES
        ('log-1', 'conv-1', 'msg-1', 'anthropic', '{}', '{}', 1000)
    `);

    migrateLlmRequestLogAgentLoopExitReason(db);

    const row = raw
      .query(`SELECT * FROM llm_request_logs WHERE id = 'log-1'`)
      .get() as {
      id: string;
      agent_loop_exit_reason: string | null;
    };
    expect(row.id).toBe("log-1");
    expect(row.agent_loop_exit_reason).toBeNull();
  });
});
