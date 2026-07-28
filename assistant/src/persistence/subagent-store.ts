/**
 * Persistence for subagent lifecycle records (the `subagents` table, created by
 * migration 311).
 *
 * This module owns only the durable row shape and raw SQL. The mapping to and
 * from the manager's `SubagentState` lives in `SubagentManager`, keeping this
 * layer decoupled from the subagent domain types. The one domain function it
 * does reach for is `normalizeSubagentLabel`: label lookups have to fold
 * exactly the way the manager's in-memory index folds, and SQLite has no
 * equivalent (`lower()` is ASCII-only), so the comparison runs in JS against
 * the single shared normalizer rather than a SQL predicate that can drift.
 */

import { normalizeSubagentLabel } from "../subagent/types.js";
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
  /**
   * Tool-use id of the call that spawned this subagent; null when the spawn
   * had no anchoring tool call.
   */
  parentToolUseId: string | null;
  status: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

/**
 * A record plus its SQLite `rowid`, which is insertion order and therefore
 * spawn order (a row is written when the subagent is spawned). Breaks a
 * same-millisecond `created_at` tie deterministically. Kept off
 * `SubagentRecord` so it cannot ride a record spread onto a wire response.
 */
export interface RehydratableSubagentRecord extends SubagentRecord {
  spawnSeq: number;
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
  parent_tool_use_id: string | null;
  status: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
}

interface RehydratableSubagentRow extends SubagentRow {
  spawn_seq: number;
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
    parentToolUseId: r.parent_tool_use_id,
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

function rowToRehydratableRecord(
  r: RehydratableSubagentRow,
): RehydratableSubagentRecord {
  return { ...rowToRecord(r), spawnSeq: r.spawn_seq };
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
       is_fork, send_result_to_user, parent_tool_use_id, status, error,
       created_at, started_at, completed_at, input_tokens, output_tokens,
       estimated_cost
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    rec.parentToolUseId,
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

/** Load every persisted subagent record, unbounded. */
export function loadAllSubagentRecords(): SubagentRecord[] {
  return rawAll<SubagentRow>("subagent:loadAll", `SELECT * FROM subagents`).map(
    rowToRecord,
  );
}

/**
 * The subagent records a restart should rebuild in memory. Rows live as long as
 * their parent conversation, so the table is unbounded history while a
 * rehydrated entry only serves the current session, and the result is bounded:
 * every row whose status is NOT in `bound.terminalStatuses` is returned (an
 * unsettled row has to be settled at any age), plus the `bound.maxTerminal`
 * most recently finished terminal rows. Recency is `completed_at` falling back
 * to `created_at`, since a row settled at rehydration records no completion
 * time.
 *
 * The terminal status set is supplied by the caller so this layer stays
 * decoupled from the subagent domain's status enum.
 *
 * Each record carries its `spawnSeq`: the branches are unordered relative to
 * each other, so the caller needs a spawn key that does not depend on the order
 * rows arrive in.
 */
export function loadRehydratableSubagentRecords(bound: {
  terminalStatuses: readonly string[];
  maxTerminal: number;
}): RehydratableSubagentRecord[] {
  const placeholders = bound.terminalStatuses.map(() => "?").join(", ");
  return rawAll<RehydratableSubagentRow>(
    "subagent:loadRehydratable",
    `SELECT *, rowid AS spawn_seq FROM subagents WHERE status NOT IN (${placeholders})
     UNION ALL
     SELECT * FROM (
       SELECT *, rowid AS spawn_seq FROM subagents
         WHERE status IN (${placeholders})
         ORDER BY COALESCE(completed_at, created_at) DESC
         LIMIT ?
     )`,
    ...bound.terminalStatuses,
    ...bound.terminalStatuses,
    bound.maxTerminal,
  ).map(rowToRehydratableRecord);
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

/**
 * Look up a subagent record by its own id. This is the durable fallback for
 * subagents the live SubagentManager no longer holds, evicted by the TTL sweep,
 * not yet rehydrated after a restart, or past the rehydration bound.
 */
export function getSubagentRecordById(id: string): SubagentRecord | undefined {
  const row = rawGet<SubagentRow>(
    "subagent:getById",
    `SELECT * FROM subagents WHERE id = ?`,
    id,
  );
  return row ? rowToRecord(row) : undefined;
}

/**
 * The most recent subagent a parent spawned under `normalizedLabel`, or
 * `undefined` when it never used that label. The durable counterpart of the
 * manager's label index, for a subagent the manager no longer holds. The
 * caller supplies the label already normalized, by `normalizeSubagentLabel`,
 * which is what the rows are folded with here too.
 *
 * The match runs in JS, not SQL: SQLite's `lower()` folds ASCII only, so a SQL
 * predicate silently misses a label such as `ÉTAPE` that the Unicode-aware
 * normalizer matches, and the durable path would then disagree with the
 * in-memory index. Only the parent's own rows are read, served by
 * `idx_subagents_parent_conversation_id` and few per conversation.
 *
 * Ordered by spawn order, matching the in-memory index, which the manager moves
 * to the newest subagent to claim the label whatever order the runs finish in.
 * Ordering by completion instead would resolve two concurrent same-label runs
 * to the older one whenever the newer finished first. `rowid` breaks a
 * same-millisecond `created_at` tie by insertion order, which is spawn order.
 */
export function getSubagentRecordByLabel(
  parentConversationId: string,
  normalizedLabel: string,
): SubagentRecord | undefined {
  const rows = rawAll<SubagentRow>(
    "subagent:getByLabel",
    `SELECT * FROM subagents
       WHERE parent_conversation_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    parentConversationId,
  );
  const row = rows.find(
    (r) => normalizeSubagentLabel(r.label) === normalizedLabel,
  );
  return row ? rowToRecord(row) : undefined;
}

/**
 * Subagent records spawned under `parentConversationId`. Durable rows outlive
 * the manager's in-memory metadata, the TTL sweep evicts terminal entries with
 * `keepRecord: true`, so this is the only way to enumerate a parent's
 * subagents that finished long enough ago to have been swept.
 *
 * Rows live as long as the parent conversation, so a long-lived chat
 * accumulates them without limit and the result is bounded: every row whose
 * status is NOT in `bound.terminalStatuses` is returned (an unsettled row
 * matters at any age), plus the `bound.maxTerminal` most recently finished
 * terminal rows. Recency is `completed_at` falling back to `created_at`, since
 * a row settled at rehydration records no completion time.
 *
 * The terminal status set is supplied by the caller so this layer stays
 * decoupled from the subagent domain's status enum.
 */
export function getSubagentRecordsByParent(
  parentConversationId: string,
  bound: { terminalStatuses: readonly string[]; maxTerminal: number },
): SubagentRecord[] {
  const placeholders = bound.terminalStatuses.map(() => "?").join(", ");
  return rawAll<SubagentRow>(
    "subagent:getByParent",
    `SELECT * FROM subagents
       WHERE parent_conversation_id = ? AND status NOT IN (${placeholders})
     UNION ALL
     SELECT * FROM (
       SELECT * FROM subagents
         WHERE parent_conversation_id = ? AND status IN (${placeholders})
         ORDER BY COALESCE(completed_at, created_at) DESC
         LIMIT ?
     )`,
    parentConversationId,
    ...bound.terminalStatuses,
    parentConversationId,
    ...bound.terminalStatuses,
    bound.maxTerminal,
  ).map(rowToRecord);
}

/**
 * Delete every subagent record spawned under `parentConversationId`. A row
 * lives as long as its parent conversation, and the TTL sweep drops a child's
 * in-memory entry while keeping the row, so deleting by id alone strands the
 * swept children when the parent goes away. Served by
 * `idx_subagents_parent_conversation_id`.
 */
export function deleteSubagentRecordsByParent(
  parentConversationId: string,
): void {
  rawRun(
    "subagent:deleteRecordsByParent",
    `DELETE FROM subagents WHERE parent_conversation_id = ?`,
    parentConversationId,
  );
}

/** Delete every subagent record. For clear-all, when all chat data goes away. */
export function deleteAllSubagentRecords(): void {
  rawRun("subagent:deleteAllRecords", `DELETE FROM subagents`);
}
