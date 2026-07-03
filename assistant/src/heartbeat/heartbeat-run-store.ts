import { desc, eq, lt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../persistence/db-connection.js";
import { rawChanges } from "../persistence/raw-query.js";
import { heartbeatRuns } from "../persistence/schema/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatRunStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "timeout"
  | "skipped"
  | "missed"
  | "superseded";

export type HeartbeatSkipReason =
  | "disabled"
  | "outside_active_hours"
  | "overlap"
  | "pre_first_user_message"
  | "max_consecutive_runs"
  | "max_daily_runs";

export interface HeartbeatRunRecord {
  id: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: HeartbeatRunStatus;
  skipReason: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold for marking stale running rows as error (45 minutes). */
const STALE_RUNNING_THRESHOLD_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store functions
// ---------------------------------------------------------------------------

/**
 * Insert a new heartbeat run in `pending` status.
 * Returns the generated run id.
 */
export function insertPendingHeartbeatRun(scheduledFor: number): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(heartbeatRuns)
    .values({
      id,
      scheduledFor,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      status: "pending",
      skipReason: null,
      error: null,
      conversationId: null,
      createdAt: now,
    })
    .run();
  return id;
}

/**
 * CAS transition from `pending` to `running`. Sets `startedAt` to now.
 * Returns `true` if the transition succeeded.
 */
export function startHeartbeatRun(runId: string): boolean {
  const db = getDb();
  const now = Date.now();
  db.update(heartbeatRuns)
    .set({ status: "running", startedAt: now })
    .where(
      sql`${heartbeatRuns.id} = ${runId} AND ${heartbeatRuns.status} = 'pending'`,
    )
    .run();
  return rawChanges() > 0;
}

/**
 * CAS transition from `running` to a terminal status (`ok`, `error`, or `timeout`).
 * Computes `durationMs` from the row's `startedAt`. Error text is capped at 2 KB.
 * Returns `true` if the transition succeeded.
 */
export function completeHeartbeatRun(
  runId: string,
  result: {
    status: "ok" | "error" | "timeout";
    conversationId?: string;
    error?: string;
  },
): boolean {
  const db = getDb();
  const now = Date.now();

  // Read the row to get startedAt for durationMs computation.
  const row = db
    .select({ startedAt: heartbeatRuns.startedAt })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .get();
  if (!row) return false;

  const durationMs = row.startedAt != null ? now - row.startedAt : null;

  db.update(heartbeatRuns)
    .set({
      status: result.status,
      finishedAt: now,
      durationMs,
      error: result.error?.slice(0, 2000) ?? null,
      conversationId: result.conversationId ?? null,
    })
    .where(
      sql`${heartbeatRuns.id} = ${runId} AND ${heartbeatRuns.status} = 'running'`,
    )
    .run();
  return rawChanges() > 0;
}

/**
 * CAS transition from `pending` to `skipped` with the given reason.
 * Returns `true` if the transition succeeded.
 */
export function skipHeartbeatRun(
  runId: string,
  skipReason: HeartbeatSkipReason,
): boolean {
  const db = getDb();
  db.update(heartbeatRuns)
    .set({ status: "skipped", skipReason })
    .where(
      sql`${heartbeatRuns.id} = ${runId} AND ${heartbeatRuns.status} = 'pending'`,
    )
    .run();
  return rawChanges() > 0;
}

/**
 * CAS transition from `pending` to `superseded`.
 * Returns `true` if the transition succeeded.
 */
export function supersedePendingRun(runId: string): boolean {
  const db = getDb();
  db.update(heartbeatRuns)
    .set({ status: "superseded" })
    .where(
      sql`${heartbeatRuns.id} = ${runId} AND ${heartbeatRuns.status} = 'pending'`,
    )
    .run();
  return rawChanges() > 0;
}

/**
 * Mark all `pending` rows older than the threshold as `missed`.
 * Handles the crash-before-run scenario. Returns the number of rows affected.
 */
export function markStaleRunsAsMissed(
  thresholdMs: number = 5 * 60 * 1000,
): number {
  const db = getDb();
  const cutoff = Date.now() - thresholdMs;
  db.update(heartbeatRuns)
    .set({ status: "missed" })
    .where(
      sql`${heartbeatRuns.status} = 'pending' AND ${heartbeatRuns.scheduledFor} < ${cutoff}`,
    )
    .run();
  return rawChanges();
}

/**
 * Mark all `running` rows older than the threshold as `error`.
 * Handles the crash-during-run scenario. Returns the number of rows affected.
 */
export function markStaleRunningAsError(
  thresholdMs: number = STALE_RUNNING_THRESHOLD_MS,
): number {
  const db = getDb();
  const cutoff = Date.now() - thresholdMs;
  db.update(heartbeatRuns)
    .set({
      status: "error",
      error: "Process crashed or restarted during execution",
    })
    .where(
      sql`${heartbeatRuns.status} = 'running' AND ${heartbeatRuns.startedAt} < ${cutoff}`,
    )
    .run();
  return rawChanges();
}

/**
 * Count the number of heartbeat runs that completed with status `ok`.
 */
export function countCompletedHeartbeatRuns(): number {
  const db = getDb();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.status, "ok"))
    .get();
  return row?.count ?? 0;
}

/**
 * Count heartbeat runs that completed with status `ok` today (local midnight).
 */
export function countCompletedRunsToday(): number {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(
      sql`${heartbeatRuns.status} = 'ok' AND ${heartbeatRuns.scheduledFor} >= ${startOfDay}`,
    )
    .get();
  return row?.count ?? 0;
}

/**
 * Count the most recent consecutive heartbeat runs with status `ok`,
 * walking backwards from newest. Stops at the first non-`ok` status
 * (skipped, superseded, missed, error, timeout), which acts as a
 * natural boundary for the consecutive-run counter. In-flight rows
 * (`pending`, `running`) are skipped so they don't break the chain.
 *
 * Used to restore the in-memory consecutive-run counter on startup.
 */
export function countRecentConsecutiveRuns(maxToCheck: number): number {
  const db = getDb();
  const rows = db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .orderBy(desc(heartbeatRuns.scheduledFor))
    .limit(maxToCheck + 5)
    .all();

  let count = 0;
  for (const row of rows) {
    if (row.status === "ok") {
      count++;
    } else if (row.status === "pending" || row.status === "running") {
      continue;
    } else {
      break;
    }
  }
  return count;
}

/**
 * List heartbeat runs ordered by `scheduledFor` descending.
 * When `before` is set, only runs with `scheduledFor` strictly older than it
 * are returned (cursor for paginating into history).
 */
export function listHeartbeatRuns(
  limit = 20,
  before?: number,
): HeartbeatRunRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(heartbeatRuns)
    .where(before != null ? lt(heartbeatRuns.scheduledFor, before) : undefined)
    .orderBy(desc(heartbeatRuns.scheduledFor))
    .limit(limit)
    .all();
  return rows.map(parseRow);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRow(row: typeof heartbeatRuns.$inferSelect): HeartbeatRunRecord {
  return {
    id: row.id,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    status: row.status as HeartbeatRunStatus,
    skipReason: row.skipReason,
    error: row.error,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}
