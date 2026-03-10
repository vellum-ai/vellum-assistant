import { and, asc, eq, inArray, lte, notInArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { getDb, rawAll, rawChanges, rawGet } from "./db.js";
import { memoryJobs } from "./schema.js";

const log = getLogger("memory-jobs-store");

export type MemoryJobType =
  | "embed_segment"
  | "embed_item"
  | "embed_summary"
  | "extract_items"
  | "extract_entities"
  | "resolve_pending_conflicts_for_message"
  | "cleanup_resolved_conflicts"
  | "cleanup_stale_superseded_items"
  | "prune_old_conversations"
  | "backfill_entity_relations"
  | "check_contradictions"
  | "refresh_weekly_summary"
  | "refresh_monthly_summary"
  | "build_conversation_summary"
  | "backfill"
  | "rebuild_index"
  | "reconcile_fts"
  | "delete_qdrant_vectors"
  | "media_processing"
  | "embed_attachment";

const EMBED_JOB_TYPES: MemoryJobType[] = [
  "embed_segment",
  "embed_item",
  "embed_summary",
  "embed_attachment",
];

export interface MemoryJob<T = Record<string, unknown>> {
  id: string;
  type: MemoryJobType;
  payload: T;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  deferrals: number;
  runAfter: number;
  lastError: string | null;
  startedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function enqueueMemoryJob(
  type: MemoryJobType,
  payload: Record<string, unknown>,
  runAfter = Date.now(),
  dbOverride?: Parameters<ReturnType<typeof getDb>["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): string {
  const db = dbOverride ?? getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(memoryJobs)
    .values({
      id,
      type,
      payload: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      deferrals: 0,
      runAfter,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/**
 * Ensure there is only one pending relation backfill orchestrator job.
 * If `force=true` arrives while a pending job exists, its payload is upgraded.
 */
export function enqueueBackfillEntityRelationsJob(force = false): string {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "backfill_entity_relations"),
        eq(memoryJobs.status, "pending"),
      ),
    )
    .orderBy(asc(memoryJobs.createdAt))
    .get();

  if (existing) {
    if (force) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(existing.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (payload.force !== true) {
        db.update(memoryJobs)
          .set({
            payload: JSON.stringify({ ...payload, force: true }),
            updatedAt: now,
          })
          .where(eq(memoryJobs.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }

  return enqueueMemoryJob("backfill_entity_relations", { force });
}

export function enqueueResolvePendingConflictsForMessageJob(
  messageId: string,
  scopeId = "default",
  dbOverride?: Parameters<ReturnType<typeof getDb>["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): string {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) {
    throw new Error(
      "enqueueResolvePendingConflictsForMessageJob requires a non-empty messageId",
    );
  }
  const normalizedScopeId = scopeId.trim() || "default";
  // Dedup check always uses root db since tx doesn't expose raw client
  const existing = rawGet<{ id: string }>(
    `
    SELECT id
    FROM memory_jobs
    WHERE type = 'resolve_pending_conflicts_for_message'
      AND status IN ('pending', 'running')
      AND json_extract(payload, '$.messageId') = ?
      AND COALESCE(json_extract(payload, '$.scopeId'), 'default') = ?
    ORDER BY created_at ASC
    LIMIT 1
  `,
    normalizedMessageId,
    normalizedScopeId,
  );
  if (existing?.id) return existing.id;

  return enqueueMemoryJob(
    "resolve_pending_conflicts_for_message",
    {
      messageId: normalizedMessageId,
      scopeId: normalizedScopeId,
    },
    Date.now(),
    dbOverride,
  );
}

export function enqueueCleanupResolvedConflictsJob(
  retentionMs?: number,
): string {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "cleanup_resolved_conflicts"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .orderBy(asc(memoryJobs.createdAt))
    .get();
  if (existing) {
    if (
      existing.status === "pending" &&
      typeof retentionMs === "number" &&
      Number.isFinite(retentionMs) &&
      retentionMs > 0
    ) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(existing.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (payload.retentionMs !== retentionMs) {
        db.update(memoryJobs)
          .set({
            payload: JSON.stringify({ ...payload, retentionMs }),
            updatedAt: now,
          })
          .where(eq(memoryJobs.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }
  const payload =
    typeof retentionMs === "number" &&
    Number.isFinite(retentionMs) &&
    retentionMs > 0
      ? { retentionMs }
      : {};
  return enqueueMemoryJob("cleanup_resolved_conflicts", payload);
}

export function enqueueCleanupStaleSupersededItemsJob(
  retentionMs?: number,
): string {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "cleanup_stale_superseded_items"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .orderBy(asc(memoryJobs.createdAt))
    .get();
  if (existing) {
    if (
      existing.status === "pending" &&
      typeof retentionMs === "number" &&
      Number.isFinite(retentionMs) &&
      retentionMs > 0
    ) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(existing.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (payload.retentionMs !== retentionMs) {
        db.update(memoryJobs)
          .set({
            payload: JSON.stringify({ ...payload, retentionMs }),
            updatedAt: now,
          })
          .where(eq(memoryJobs.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }
  const payload =
    typeof retentionMs === "number" &&
    Number.isFinite(retentionMs) &&
    retentionMs > 0
      ? { retentionMs }
      : {};
  return enqueueMemoryJob("cleanup_stale_superseded_items", payload);
}

export function enqueuePruneOldConversationsJob(
  retentionDays?: number,
): string {
  const db = getDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "prune_old_conversations"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .orderBy(asc(memoryJobs.createdAt))
    .get();
  if (existing) {
    if (
      existing.status === "pending" &&
      typeof retentionDays === "number" &&
      Number.isFinite(retentionDays) &&
      retentionDays >= 0
    ) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(existing.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (payload.retentionDays !== retentionDays) {
        db.update(memoryJobs)
          .set({
            payload: JSON.stringify({ ...payload, retentionDays }),
            updatedAt: Date.now(),
          })
          .where(eq(memoryJobs.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }
  const payload =
    typeof retentionDays === "number" &&
    Number.isFinite(retentionDays) &&
    retentionDays >= 0
      ? { retentionDays }
      : {};
  return enqueueMemoryJob("prune_old_conversations", payload);
}

export function enqueueReconcileFtsJob(): string {
  const db = getDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "reconcile_fts"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .orderBy(asc(memoryJobs.createdAt))
    .get();
  if (existing) return existing.id;
  return enqueueMemoryJob("reconcile_fts", {});
}

export function claimMemoryJobs(limit: number): MemoryJob[] {
  if (limit <= 0) return [];
  const db = getDb();
  const now = Date.now();
  const pendingFilter = and(
    eq(memoryJobs.status, "pending"),
    lte(memoryJobs.runAfter, now),
  );

  // Claim non-embed jobs first, then fill remaining slots with embed jobs.
  // This prevents embed retries from starving other job types during a backend outage.
  const nonEmbedCandidates = db
    .select()
    .from(memoryJobs)
    .where(and(pendingFilter, notInArray(memoryJobs.type, EMBED_JOB_TYPES)))
    .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
    .limit(limit)
    .all();

  const remainingSlots = limit - nonEmbedCandidates.length;
  const embedCandidates =
    remainingSlots > 0
      ? db
          .select()
          .from(memoryJobs)
          .where(and(pendingFilter, inArray(memoryJobs.type, EMBED_JOB_TYPES)))
          .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
          .limit(remainingSlots)
          .all()
      : [];

  const candidates = [...nonEmbedCandidates, ...embedCandidates];

  const claimed: MemoryJob[] = [];
  for (const row of candidates) {
    db.update(memoryJobs)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(and(eq(memoryJobs.id, row.id), eq(memoryJobs.status, "pending")))
      .run();
    if (rawChanges() === 0) continue;
    claimed.push(
      parseRow({
        ...row,
        status: "running",
        startedAt: now,
        updatedAt: now,
      }),
    );
  }
  return claimed;
}

export function completeMemoryJob(id: string): void {
  const db = getDb();
  db.update(memoryJobs)
    .set({ status: "completed", updatedAt: Date.now(), lastError: null })
    .where(eq(memoryJobs.id, id))
    .run();
}

/** Max times a job can be deferred before it is marked as failed. */
const MAX_DEFERRALS = 50;
/** Warn when deferrals reach 80% of the limit. */
const DEFER_WARNING_THRESHOLD = Math.floor(MAX_DEFERRALS * 0.8);
/** Base delay in ms for deferred jobs (grows with exponential backoff). */
const DEFER_BASE_DELAY_MS = 30_000;
/** Maximum delay cap for deferred jobs (5 minutes). */
const DEFER_MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * Move a running job back to pending with exponential backoff.
 * Used when the failure is a missing configuration (not a transient error).
 * The job's deferral counter is incremented (separate from the retry attempt
 * counter used by {@link failMemoryJob}) so that backoff grows and the job
 * eventually fails after {@link MAX_DEFERRALS} deferrals without consuming
 * the retry budget for transient errors.
 *
 * Returns `'deferred'` if the job was put back, or `'failed'` if max deferrals
 * were exceeded and the job was marked as failed.
 */
export function deferMemoryJob(id: string): "deferred" | "failed" {
  const db = getDb();
  const row = db.select().from(memoryJobs).where(eq(memoryJobs.id, id)).get();
  if (!row) return "failed";

  const deferrals = row.deferrals + 1;
  const now = Date.now();

  if (deferrals >= MAX_DEFERRALS) {
    log.error(
      { jobId: id, type: row.type, deferrals },
      "Job exceeded max deferrals, marking as failed",
    );
    db.update(memoryJobs)
      .set({
        status: "failed",
        deferrals,
        updatedAt: now,
        lastError: `Backend unavailable after ${deferrals} deferrals`,
      })
      .where(eq(memoryJobs.id, id))
      .run();
    return "failed";
  }

  if (deferrals >= DEFER_WARNING_THRESHOLD) {
    log.warn(
      { jobId: id, type: row.type, deferrals, max: MAX_DEFERRALS },
      "Job approaching max deferral limit",
    );
  }

  // Exponential backoff: 30s, 60s, 120s, ... capped at 5 minutes
  const delay = Math.min(
    DEFER_BASE_DELAY_MS * Math.pow(2, Math.min(deferrals - 1, 10)),
    DEFER_MAX_DELAY_MS,
  );
  db.update(memoryJobs)
    .set({
      status: "pending",
      deferrals,
      runAfter: now + delay,
      updatedAt: now,
    })
    .where(eq(memoryJobs.id, id))
    .run();
  return "deferred";
}

export function failMemoryJob(
  id: string,
  error: string,
  options?: { retryDelayMs?: number; maxAttempts?: number },
): void {
  const retryDelayMs = options?.retryDelayMs ?? 30_000;
  const maxAttempts = options?.maxAttempts ?? 5;
  const db = getDb();
  const row = db.select().from(memoryJobs).where(eq(memoryJobs.id, id)).get();
  if (!row) return;
  const attempts = row.attempts + 1;
  const now = Date.now();
  if (attempts >= maxAttempts) {
    db.update(memoryJobs)
      .set({
        status: "failed",
        attempts,
        updatedAt: now,
        lastError: truncate(error, 2000, ""),
      })
      .where(eq(memoryJobs.id, id))
      .run();
    return;
  }
  db.update(memoryJobs)
    .set({
      status: "pending",
      attempts,
      runAfter: now + retryDelayMs,
      updatedAt: now,
      lastError: truncate(error, 2000, ""),
    })
    .where(eq(memoryJobs.id, id))
    .run();
}

export function resetRunningJobsToPending(): number {
  const db = getDb();
  const runningRows = db
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(eq(memoryJobs.status, "running"))
    .all();
  db.update(memoryJobs)
    .set({ status: "pending", updatedAt: Date.now() })
    .where(eq(memoryJobs.status, "running"))
    .run();
  return runningRows.length;
}

/**
 * Fail running jobs whose `startedAt` is older than `timeoutMs` ago.
 * Returns the number of jobs that were timed out.
 */
export function failStalledJobs(timeoutMs: number): number {
  const now = Date.now();
  const cutoff = now - timeoutMs;
  const stalled = rawAll<{ id: string; type: string }>(
    `
    SELECT id, type
    FROM memory_jobs
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at < ?
  `,
    cutoff,
  );
  if (stalled.length === 0) return 0;

  const db = getDb();
  for (const row of stalled) {
    db.update(memoryJobs)
      .set({
        status: "failed",
        updatedAt: now,
        lastError: `Job timed out after ${Math.round(
          timeoutMs / 60_000,
        )} minutes`,
      })
      .where(and(eq(memoryJobs.id, row.id), eq(memoryJobs.status, "running")))
      .run();
    log.warn(
      { jobId: row.id, type: row.type, timeoutMs },
      "Failed stalled memory job due to timeout",
    );
  }
  return stalled.length;
}

export function getMemoryJobCounts(): Record<string, number> {
  const rows = rawAll<{ status: string; c: number }>(`
    SELECT status, COUNT(*) AS c
    FROM memory_jobs
    GROUP BY status
  `);
  const counts: Record<string, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.c;
  }
  return counts;
}

function parseRow(row: typeof memoryJobs.$inferSelect): MemoryJob {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    type: row.type as MemoryJobType,
    payload,
    status: row.status as MemoryJob["status"],
    attempts: row.attempts,
    deferrals: row.deferrals,
    runAfter: row.runAfter,
    lastError: row.lastError,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
