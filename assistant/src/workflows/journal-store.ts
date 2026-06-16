/**
 * Typed persistence for the workflow orchestration engine.
 *
 * Two tables (created by migration 282):
 *
 * - `workflow_runs` — one row per orchestration run (a sandboxed script that
 *   spawns parallel leaf agents), tracking lifecycle status and token usage.
 * - `workflow_journal` — append-only `(run_id, seq)` log of every leaf call
 *   (agent / host function / nested workflow). On resume after a daemon
 *   restart, the engine replays cached results for the unchanged call prefix
 *   instead of re-spawning agents.
 *
 * This module is pure persistence — no `workflows` feature-flag logic. Callers
 * (the engine, a later PR) own gating.
 */

import { rawAll, rawGet, rawRun } from "../memory/raw-query.js";

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "cap_exceeded"
  | "interrupted";

/**
 * The journal records leaf-agent calls (`"agent"`) and nested `workflow()`
 * resolutions (`"workflow"`). A `"workflow"` entry snapshots the resolved child
 * source under its own `seq` so a resumed run re-executes the SAME child code
 * the original launch did, even if the saved workflow was since edited or
 * deleted. The column stays TEXT so adding kinds later needs no migration.
 */
export type WorkflowJournalKind = "agent" | "workflow";

/** A persisted workflow run row, with JSON columns parsed into values. */
export interface WorkflowRun {
  id: string;
  name: string | null;
  scriptSource: string;
  scriptHash: string;
  args: unknown;
  capabilities: unknown;
  status: WorkflowRunStatus;
  conversationId: string | null;
  /**
   * Originating trust context (parsed), or null for legacy rows written before
   * the column existed. Reconstructed on resume so a run never resumes with more
   * trust than it started under — see {@link CreateRunInput.trust}.
   */
  trust: unknown;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  result: unknown;
  error: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
}

/** A persisted journal entry, with JSON columns parsed into values. */
export interface WorkflowJournalEntry {
  runId: string;
  seq: number;
  callHash: string;
  kind: WorkflowJournalKind;
  request: unknown;
  result: unknown;
  status: string;
  createdAt: number | null;
}

export interface CreateRunInput {
  id: string;
  name?: string | null;
  scriptSource: string;
  scriptHash: string;
  args?: unknown;
  capabilities?: unknown;
  status?: WorkflowRunStatus;
  conversationId?: string | null;
  /**
   * Originating trust context (trust metadata — `{ sourceChannel, trustClass,
   * ... }`, no secret material), serialized so a crash-orphaned run can
   * reconstruct the exact trust class it started under when resumed. Omit on
   * legacy callers; resume then falls back to low trust, never guardian.
   */
  trust?: unknown;
}

export interface UpdateRunInput {
  status?: WorkflowRunStatus;
  agentsSpawned?: number;
  inputTokens?: number;
  outputTokens?: number;
  conversationId?: string | null;
}

export interface FinishRunInput {
  status: WorkflowRunStatus;
  result?: unknown;
  error?: string | null;
}

export interface AppendJournalEntryInput {
  runId: string;
  seq: number;
  callHash: string;
  kind: WorkflowJournalKind;
  request?: unknown;
  result?: unknown;
  status: string;
}

// ---------------------------------------------------------------------------
// Row shapes + mappers
// ---------------------------------------------------------------------------

interface WorkflowRunRow {
  id: string;
  name: string | null;
  script_source: string;
  script_hash: string;
  args_json: string | null;
  capabilities_json: string | null;
  status: string;
  conversation_id: string | null;
  trust_json: string | null;
  agents_spawned: number;
  input_tokens: number;
  output_tokens: number;
  result_json: string | null;
  error: string | null;
  created_at: number | null;
  updated_at: number | null;
  finished_at: number | null;
}

interface WorkflowJournalRow {
  run_id: string;
  seq: number;
  call_hash: string;
  kind: string;
  request_json: string | null;
  result_json: string | null;
  status: string;
  created_at: number | null;
}

/** Parse a nullable JSON column; malformed values collapse to null. */
function parseJsonColumn(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Serialize a value for a nullable JSON column. `undefined` stores as null. */
function serializeJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    name: row.name,
    scriptSource: row.script_source,
    scriptHash: row.script_hash,
    args: parseJsonColumn(row.args_json),
    capabilities: parseJsonColumn(row.capabilities_json),
    status: row.status as WorkflowRunStatus,
    conversationId: row.conversation_id,
    trust: parseJsonColumn(row.trust_json),
    agentsSpawned: row.agents_spawned,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    result: parseJsonColumn(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rowToJournalEntry(row: WorkflowJournalRow): WorkflowJournalEntry {
  return {
    runId: row.run_id,
    seq: row.seq,
    callHash: row.call_hash,
    kind: row.kind as WorkflowJournalKind,
    request: parseJsonColumn(row.request_json),
    result: parseJsonColumn(row.result_json),
    status: row.status,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Runs — write
// ---------------------------------------------------------------------------

/** Insert a new workflow run. Defaults status to `running`. */
export function createRun(input: CreateRunInput): WorkflowRun {
  const now = Date.now();
  const status = input.status ?? "running";
  rawRun(
    /*sql*/ `
    INSERT INTO workflow_runs (
      id, name, script_source, script_hash, args_json, capabilities_json,
      status, conversation_id, trust_json, agents_spawned, input_tokens,
      output_tokens, result_json, error, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, NULL)
    `,
    input.id,
    input.name ?? null,
    input.scriptSource,
    input.scriptHash,
    serializeJsonColumn(input.args),
    serializeJsonColumn(input.capabilities),
    status,
    input.conversationId ?? null,
    serializeJsonColumn(input.trust),
    now,
    now,
  );
  return getRun(input.id)!;
}

/**
 * Patch mutable fields on a run and bump `updated_at`. Only the fields present
 * in `input` are written. Returns the updated run, or null if it doesn't exist.
 */
export function updateRun(
  runId: string,
  input: UpdateRunInput,
): WorkflowRun | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.agentsSpawned !== undefined) {
    sets.push("agents_spawned = ?");
    params.push(input.agentsSpawned);
  }
  if (input.inputTokens !== undefined) {
    sets.push("input_tokens = ?");
    params.push(input.inputTokens);
  }
  if (input.outputTokens !== undefined) {
    sets.push("output_tokens = ?");
    params.push(input.outputTokens);
  }
  if (input.conversationId !== undefined) {
    sets.push("conversation_id = ?");
    params.push(input.conversationId);
  }

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(runId);

  rawRun(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return getRun(runId);
}

/**
 * Mark a run terminal: set its final status, result/error payload, and stamp
 * both `updated_at` and `finished_at`. Returns the updated run, or null if it
 * doesn't exist.
 */
export function finishRun(
  runId: string,
  input: FinishRunInput,
): WorkflowRun | null {
  const now = Date.now();
  rawRun(
    /*sql*/ `
    UPDATE workflow_runs
    SET status = ?, result_json = ?, error = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
    `,
    input.status,
    serializeJsonColumn(input.result),
    input.error ?? null,
    now,
    now,
    runId,
  );
  return getRun(runId);
}

// ---------------------------------------------------------------------------
// Journal — write
// ---------------------------------------------------------------------------

/**
 * Append a leaf-call entry to a run's journal, upserting on `(run_id, seq)`.
 *
 * A genuine duplicate re-append (same hash/result — the crash-recovery case
 * where a write replays after a crash between the call and its journal write)
 * is idempotent: the conflicting row is overwritten with identical values.
 *
 * On resume, a leaf whose input CHANGED re-runs and produces a new
 * hash/result/status at the same `seq`; the UPSERT rewrites the stale first-run
 * row so the persisted journal agrees with the value the engine returned (and
 * the call doesn't re-run on every future resume). `created_at` is left at its
 * original value on conflict so the row keeps its first-write timestamp.
 */
export function appendJournalEntry(
  input: AppendJournalEntryInput,
): WorkflowJournalEntry {
  rawRun(
    /*sql*/ `
    INSERT INTO workflow_journal (
      run_id, seq, call_hash, kind, request_json, result_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, seq) DO UPDATE SET
      call_hash = excluded.call_hash,
      kind = excluded.kind,
      request_json = excluded.request_json,
      result_json = excluded.result_json,
      status = excluded.status
    `,
    input.runId,
    input.seq,
    input.callHash,
    input.kind,
    serializeJsonColumn(input.request),
    serializeJsonColumn(input.result),
    input.status,
    Date.now(),
  );
  return getJournalEntry(input.runId, input.seq)!;
}

// ---------------------------------------------------------------------------
// Runs + journal — read
// ---------------------------------------------------------------------------

/** Fetch a single run by id, or null if it doesn't exist. */
export function getRun(runId: string): WorkflowRun | null {
  const row = rawGet<WorkflowRunRow>(
    `SELECT * FROM workflow_runs WHERE id = ?`,
    runId,
  );
  return row ? rowToRun(row) : null;
}

/** Fetch a run's full journal in sequence order for resume replay. */
export function getJournal(runId: string): WorkflowJournalEntry[] {
  const rows = rawAll<WorkflowJournalRow>(
    `SELECT * FROM workflow_journal WHERE run_id = ? ORDER BY seq ASC`,
    runId,
  );
  return rows.map(rowToJournalEntry);
}

/** Fetch a single journal entry by its `(run_id, seq)` key, or null. */
export function getJournalEntry(
  runId: string,
  seq: number,
): WorkflowJournalEntry | null {
  const row = rawGet<WorkflowJournalRow>(
    `SELECT * FROM workflow_journal WHERE run_id = ? AND seq = ?`,
    runId,
    seq,
  );
  return row ? rowToJournalEntry(row) : null;
}

export interface ListRunsOptions {
  limit: number;
  status?: WorkflowRunStatus;
}

/** List runs newest-first, optionally filtered by status. */
export function listRuns(options: ListRunsOptions): WorkflowRun[] {
  const rows = options.status
    ? rawAll<WorkflowRunRow>(
        `SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        options.status,
        options.limit,
      )
    : rawAll<WorkflowRunRow>(
        `SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?`,
        options.limit,
      );
  return rows.map(rowToRun);
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Flip every `running` run to `interrupted`. Called once at daemon startup: a
 * row left in `running` means the process died mid-run (nothing else can leave
 * a row `running` after the engine exits, which always finishes it). Marking it
 * `interrupted` makes it eligible for an explicit resume.
 *
 * STATUS ONLY — `agents_spawned`/`input_tokens`/`output_tokens` are NOT touched.
 * The run row is the source of truth for ACCOUNTING (it seeds the resumed run's
 * cap counters) while the journal is the source of truth for REPLAY; rewriting
 * the counters here would drift the cap accounting. Returns the number of rows
 * reconciled.
 */
export function markRunningAsInterrupted(): number {
  return rawRun(
    /*sql*/ `UPDATE workflow_runs SET status = 'interrupted', updated_at = ? WHERE status = 'running'`,
    Date.now(),
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Set of genuinely TERMINAL run statuses — the only rows `pruneRuns` may reap.
 * A run is non-terminal (and therefore retained regardless of age) when it is
 * still `running` OR `interrupted`: an `interrupted` run is a crash-orphaned
 * row awaiting an explicit resume, so pruning it would destroy resumability.
 */
const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "completed",
  "failed",
  "aborted",
  "cap_exceeded",
];

/** SQL list literal of the terminal statuses, e.g. `'completed','failed',...`. */
const TERMINAL_RUN_STATUS_SQL = TERMINAL_RUN_STATUSES.map((s) => `'${s}'`).join(
  ", ",
);

/**
 * Delete TERMINAL runs older than `retentionDays` (by `created_at`) and their
 * journal entries. Non-terminal runs are never pruned, regardless of age:
 * `running` rows could be reaped out from under the engine, and `interrupted`
 * rows are crash-orphaned and still resumable — deleting either would destroy
 * an in-flight or resumable run. Returns the number of runs deleted.
 */
export function pruneRuns(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  rawRun(
    /*sql*/ `
    DELETE FROM workflow_journal
    WHERE run_id IN (
      SELECT id FROM workflow_runs
      WHERE status IN (${TERMINAL_RUN_STATUS_SQL})
        AND created_at IS NOT NULL AND created_at < ?
    )
    `,
    cutoff,
  );
  return rawRun(
    /*sql*/ `
    DELETE FROM workflow_runs
    WHERE status IN (${TERMINAL_RUN_STATUS_SQL})
      AND created_at IS NOT NULL AND created_at < ?
    `,
    cutoff,
  );
}
