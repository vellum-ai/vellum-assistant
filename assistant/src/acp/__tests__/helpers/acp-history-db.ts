/**
 * Shared test helpers for the `acp_session_history` table.
 *
 * Several suites (session-manager resume/persistence, the ACP route
 * handlers) seed and read history rows directly via SQL; this module
 * consolidates the copy-pasted row shape + insert/read/clear helpers.
 * Tests must run `initializeDb()` themselves before calling these.
 */

import { getSqlite } from "../../../persistence/db-connection.js";

/** Raw column snapshot of an `acp_session_history` row. */
export interface HistoryRow {
  id: string;
  agent_id: string;
  acp_session_id: string;
  parent_conversation_id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  stop_reason: string | null;
  error: string | null;
  event_log_json: string;
  cwd: string | null;
  task: string | null;
  parent_tool_use_id: string | null;
  used_tokens: number | null;
  context_size: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export function clearHistory(): void {
  getSqlite().run("DELETE FROM acp_session_history");
}

/**
 * Inserts a history row. Every field except `id` defaults to the values
 * the resume suites were built around (a completed claude run in
 * /tmp/proj); pass explicit values to override, including `null` where the
 * column is nullable (e.g. `cwd: null` for legacy rows).
 */
export function insertHistoryRow(row: {
  id: string;
  agentId?: string;
  acpSessionId?: string;
  parentConversationId?: string;
  startedAt?: number;
  completedAt?: number | null;
  status?: string;
  stopReason?: string | null;
  error?: string | null;
  eventLogJson?: string;
  cwd?: string | null;
  task?: string | null;
  parentToolUseId?: string | null;
  usedTokens?: number | null;
  contextSize?: number | null;
  costAmount?: number | null;
  costCurrency?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): void {
  getSqlite()
    .query(
      `INSERT INTO acp_session_history (
         id, agent_id, acp_session_id, parent_conversation_id,
         started_at, completed_at, status, stop_reason, error,
         event_log_json, cwd, task, parent_tool_use_id,
         used_tokens, context_size, cost_amount, cost_currency,
         input_tokens, output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.agentId ?? "claude",
      row.acpSessionId ?? "proto-old",
      row.parentConversationId ?? "conv-1",
      row.startedAt ?? 1234,
      row.completedAt === undefined ? 5678 : row.completedAt,
      row.status ?? "completed",
      row.stopReason === undefined ? "end_turn" : row.stopReason,
      row.error ?? null,
      row.eventLogJson ?? "[]",
      row.cwd === undefined ? "/tmp/proj" : row.cwd,
      row.task ?? null,
      row.parentToolUseId ?? null,
      row.usedTokens ?? null,
      row.contextSize ?? null,
      row.costAmount ?? null,
      row.costCurrency ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
    );
}

export function readHistoryRow(id: string): HistoryRow | null {
  return getSqlite()
    .query(
      `SELECT id, agent_id, acp_session_id, parent_conversation_id,
              started_at, completed_at, status, stop_reason, error,
              event_log_json, cwd, task, parent_tool_use_id,
              used_tokens, context_size, cost_amount, cost_currency,
              input_tokens, output_tokens
       FROM acp_session_history WHERE id = ?`,
    )
    .get(id) as HistoryRow | null;
}
