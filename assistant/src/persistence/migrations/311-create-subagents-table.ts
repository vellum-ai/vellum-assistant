import { getSqlite } from "../db-connection.js";

/**
 * Creates the `subagents` table: durable lifecycle records for subagents
 * spawned by `SubagentManager`.
 *
 * Subagents run as background child conversations whose rows already persist
 * via `bootstrapConversation`, but the manager-only fields (parent link,
 * label, objective, role, fork flag, status, timestamps, usage) live only in
 * the manager's in-memory maps and are lost on restart. This table persists
 * them so a restart can rehydrate completed subagents (their output is read
 * from the child conversation's messages) and mark any that were still in
 * flight as `interrupted` rather than silently orphaning them.
 *
 * Rows are written on spawn and on every status transition, and deleted when
 * the manager disposes the subagent during normal operation (TTL sweep or
 * parent eviction) — never on shutdown, so in-flight rows survive the restart.
 *
 * Idempotent (`IF NOT EXISTS`). No backfill — pre-existing subagents predate
 * the table and were already only in-memory.
 */
export function migrateCreateSubagentsTable(): void {
  const raw = getSqlite();
  raw.exec(`
    CREATE TABLE IF NOT EXISTS subagents (
      id                     TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      conversation_id        TEXT NOT NULL,
      label                  TEXT NOT NULL,
      objective              TEXT NOT NULL,
      role                   TEXT NOT NULL DEFAULT 'general',
      is_fork                INTEGER NOT NULL DEFAULT 0,
      send_result_to_user    INTEGER,
      status                 TEXT NOT NULL DEFAULT 'pending',
      error                  TEXT,
      created_at             INTEGER NOT NULL,
      started_at             INTEGER,
      completed_at           INTEGER,
      input_tokens           INTEGER NOT NULL DEFAULT 0,
      output_tokens          INTEGER NOT NULL DEFAULT 0,
      estimated_cost         REAL NOT NULL DEFAULT 0
    )
  `);
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_subagents_parent_conversation_id ON subagents(parent_conversation_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status)`,
  );
}
