/**
 * Persistence for subagent lifecycle records (the `subagents` table, created by
 * migration 311).
 *
 * This module owns only the durable row shape and raw SQL. The mapping to and
 * from the manager's `SubagentState` lives in `SubagentManager`, keeping this
 * layer decoupled from the subagent domain types.
 */

import { rawAll, rawGet, rawRun } from "./raw-query.js";

/** A durable subagent lifecycle record (camelCase mirror of the row). */
export interface SubagentRecord {
  id: string;
  parentConversationId: string;
  conversationId: string;
  label: string;
  objective: string;
  role: string;
  isFork: boolean;
  /** Tri-state: null when the spawner left it unset. */
  sendResultToUser: boolean | null;
  status: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

/** Raw row shape (snake_case, SQLite stores booleans as 0/1). */
interface SubagentRow {
  id: string;
  parent_conversation_id: string;
  conversation_id: string;
  label: string;
  objective: string;
  role: string;
  is_fork: number;
  send_result_to_user: number | null;
  status: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
}

function rowToRecord(r: SubagentRow): SubagentRecord {
  return {
    id: r.id,
    parentConversationId: r.parent_conversation_id,
    conversationId: r.conversation_id,
    label: r.label,
    objective: r.objective,
    role: r.role,
    isFork: r.is_fork === 1,
    sendResultToUser:
      r.send_result_to_user == null ? null : r.send_result_to_user === 1,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    estimatedCost: r.estimated_cost,
  };
}

/**
 * Insert or update a subagent record. Called on spawn and on every status
 * transition; the conflict clause refreshes the mutable lifecycle fields while
 * the immutable identity/config columns stay as first written.
 */
export function upsertSubagentRecord(rec: SubagentRecord): void {
  rawRun(
    "subagent:upsertRecord",
    `INSERT INTO subagents (
       id, parent_conversation_id, conversation_id, label, objective, role,
       is_fork, send_result_to_user, status, error, created_at, started_at,
       completed_at, input_tokens, output_tokens, estimated_cost
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       error = excluded.error,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       estimated_cost = excluded.estimated_cost`,
    rec.id,
    rec.parentConversationId,
    rec.conversationId,
    rec.label,
    rec.objective,
    rec.role,
    rec.isFork ? 1 : 0,
    rec.sendResultToUser == null ? null : rec.sendResultToUser ? 1 : 0,
    rec.status,
    rec.error,
    rec.createdAt,
    rec.startedAt,
    rec.completedAt,
    rec.inputTokens,
    rec.outputTokens,
    rec.estimatedCost,
  );
}

/** Load every persisted subagent record. Used once at startup to rehydrate. */
export function loadAllSubagentRecords(): SubagentRecord[] {
  return rawAll<SubagentRow>("subagent:loadAll", `SELECT * FROM subagents`).map(
    rowToRecord,
  );
}

/**
 * Look up the subagent record whose child conversation is `conversationId`,
 * or `undefined` when the conversation is not a subagent. `conversation_id` is
 * the child's own id, so this resolves the child → parent relation (and the
 * current lifecycle status) from durable storage without consulting the live
 * SubagentManager.
 */
export function getSubagentRecordByConversationId(
  conversationId: string,
): SubagentRecord | undefined {
  const row = rawGet<SubagentRow>(
    "subagent:getByConversationId",
    `SELECT * FROM subagents WHERE conversation_id = ?`,
    conversationId,
  );
  return row ? rowToRecord(row) : undefined;
}

/** Delete a subagent record once the manager is fully done with it. */
export function deleteSubagentRecord(id: string): void {
  rawRun("subagent:deleteRecord", `DELETE FROM subagents WHERE id = ?`, id);
}
