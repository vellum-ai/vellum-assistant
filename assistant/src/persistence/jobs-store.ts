import {
  and,
  asc,
  eq,
  inArray,
  like,
  lte,
  notInArray,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { type DrizzleDb, getMemoryDb } from "./db-connection.js";
import {
  isEmbeddingBillingBreakerOpen,
  shouldAllowBillingProbe,
} from "./embeddings/embedding-billing-breaker.js";
import {
  isQdrantBreakerOpen,
  shouldAllowQdrantProbe,
} from "./embeddings/qdrant-circuit-breaker.js";
import { rawMemoryAll, rawMemoryChanges } from "./raw-query.js";
import { memoryJobs } from "./schema/index.js";

const log = getLogger("memory-jobs-store");

/**
 * The memory connection (`assistant-memory.db`), where `memory_jobs` lives.
 * Throws if the file cannot be opened — the work queue has no fallback.
 */
function memoryDb(): DrizzleDb {
  const db = getMemoryDb();
  if (!db) {
    throw new Error("memory database unavailable");
  }
  return db;
}

export type MemoryJobType =
  | "embed_segment"
  | "embed_summary"
  | "prune_old_conversations"
  | "prune_old_llm_request_logs"
  | "prune_old_trace_events"
  | "build_conversation_summary"
  | "conversation_analyze"
  | "backfill"
  | "rebuild_index"
  | "delete_qdrant_vectors"
  | "media_processing"
  | "embed_media"
  | "embed_attachment"
  | "generate_conversation_starters"
  | "embed_graph_node"
  | "embed_pkb_file"
  | "graph_extract"
  | "graph_decay"
  | "graph_consolidate"
  | "graph_pattern_scan"
  | "graph_narrative_refine"
  | "graph_trigger_embed"
  | "graph_bootstrap"
  | "embed_concept_page"
  | "memory_v2_sweep"
  | "memory_v2_consolidate"
  | "memory_v2_migrate"
  | "memory_v2_reembed"
  | "memory_v2_activation_recompute"
  | "memory_v3_maintain"
  // Retired/legacy — no live handler; persisted rows drop via LEGACY_JOB_TYPES.
  | "memory_v3_consolidate"
  | "memory_v3_index_maintenance"
  | "memory_v3_edge_learning"
  | "memory_retrospective";

export const EMBED_JOB_TYPES: MemoryJobType[] = [
  "embed_segment",
  "embed_summary",
  "embed_media",
  "embed_attachment",
  "embed_graph_node",
  "embed_pkb_file",
  "graph_trigger_embed",
  "embed_concept_page",
];

export const SLOW_LLM_JOB_TYPES: MemoryJobType[] = [
  "graph_consolidate",
  "graph_pattern_scan",
  "graph_narrative_refine",
  "graph_extract",
  "conversation_analyze",
  "build_conversation_summary",
  "generate_conversation_starters",
  "memory_v2_sweep",
  "memory_v2_consolidate",
  "memory_v3_maintain",
  "memory_v2_migrate",
  "memory_retrospective",
  "backfill",
  "graph_bootstrap",
];

export const MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS = {
  automatic: "automatic",
  manual: "manual",
} as const;

/** Returns `false` only when `config.memory.enabled` is explicitly `false`; defaults to `true` on missing config or load errors. */
export function isMemoryEnabled(): boolean {
  try {
    return getConfig().memory?.enabled !== false;
  } catch {
    return true;
  }
}

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
  dbOverride?: Parameters<DrizzleDb["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): string {
  const db = dbOverride ?? memoryDb();
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
 * The namespace every plugin job `type` carries (`plugin:<id>:<name>`),
 * assigned by the host's jobs facet so plugin code cannot forge a core type.
 * The claim path keys off this prefix to route plugin jobs to the only process
 * that registers their handlers (the in-process daemon worker) — see
 * {@link claimMemoryJobs}'s `claimMode`.
 */
export const PLUGIN_JOB_TYPE_PREFIX = "plugin:";

/** SQL `LIKE` pattern matching every {@link PLUGIN_JOB_TYPE_PREFIX} type. */
const PLUGIN_JOB_TYPE_LIKE = `${PLUGIN_JOB_TYPE_PREFIX}%`;

/**
 * Enqueue a background job under an arbitrary string `type` outside the
 * built-in {@link MemoryJobType} union — the path plugin jobs take. Plugin
 * job types are `plugin:<id>:<name>`-namespaced strings the host assigns; they
 * are not part of the core union and never collide with it. The row is
 * otherwise identical to {@link enqueueMemoryJob}, so the same worker claim/
 * dispatch path picks it up (the type lands in the fast lane since it is in
 * neither the slow nor embed set). Only the in-process daemon worker claims
 * these, since it is the lone process that runs plugin init and so registers
 * their handlers — see {@link claimMemoryJobs}'s `claimMode`. Returns the
 * enqueued job's id.
 */
export function enqueuePluginJob(
  type: string,
  payload: Record<string, unknown>,
  runAfter = Date.now(),
): string {
  return enqueueMemoryJob(type as MemoryJobType, payload, runAfter);
}

/**
 * Upsert a debounced job: if a pending job of the same type and conversation
 * already exists, merge the new payload into the existing row and update
 * `runAfter` instead of creating a duplicate. This prevents rapid message
 * indexing from spawning redundant jobs while ensuring the latest payload
 * keys (e.g. `scopeId`) reach the handler — including on upgraded instances
 * where the existing pending row was enqueued by an older build that did
 * not write those keys.
 *
 * Pass a `dbOverride` (transaction handle) to make this call atomic with
 * surrounding writes.
 */
export function upsertDebouncedJob(
  type: MemoryJobType,
  payload: { conversationId: string } & Record<string, unknown>,
  runAfter: number,
  dbOverride?: Parameters<DrizzleDb["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): void {
  const db = dbOverride ?? memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, type),
        eq(memoryJobs.status, "pending"),
        sql`json_extract(${memoryJobs.payload}, '$.conversationId') = ${payload.conversationId}`,
      ),
    )
    .get();
  if (existing) {
    let existingPayload: Record<string, unknown> = {};
    try {
      existingPayload = JSON.parse(existing.payload) as Record<string, unknown>;
    } catch {
      existingPayload = {};
    }
    const mergedPayload = { ...existingPayload, ...payload };
    db.update(memoryJobs)
      .set({
        payload: JSON.stringify(mergedPayload),
        runAfter,
        updatedAt: Date.now(),
      })
      .where(eq(memoryJobs.id, existing.id))
      .run();
  } else {
    enqueueMemoryJob(type, payload, runAfter, dbOverride);
  }
}

/**
 * Upsert a pending `conversation_analyze` job keyed by both
 * `conversationId` and `triggerGroup`. Immediate triggers (batch,
 * compaction) and debounced triggers (idle, lifecycle) live in separate
 * rows so an idle enqueue cannot push an already-scheduled immediate
 * row's `runAfter` into the future (and vice versa). Each group still
 * coalesces within itself: two batch crossings, or two idle triggers,
 * collapse to a single pending row.
 */
export function upsertAutoAnalysisJob(
  payload: {
    conversationId: string;
    triggerGroup: "immediate" | "debounced";
  },
  runAfter: number,
  dbOverride?: Parameters<DrizzleDb["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): void {
  const db = dbOverride ?? memoryDb();
  // Match rows with the same triggerGroup OR legacy rows without triggerGroup
  // (from older builds that used upsertDebouncedJob before triggerGroup was
  // introduced). Without the IS NULL fallback, the next enqueue would insert
  // a duplicate pending row for the same conversation.
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "conversation_analyze"),
        eq(memoryJobs.status, "pending"),
        sql`json_extract(${memoryJobs.payload}, '$.conversationId') = ${payload.conversationId}`,
        or(
          sql`json_extract(${memoryJobs.payload}, '$.triggerGroup') = ${payload.triggerGroup}`,
          sql`json_extract(${memoryJobs.payload}, '$.triggerGroup') IS NULL`,
        ),
      ),
    )
    .get();
  if (existing) {
    // Merge triggerGroup into legacy rows so subsequent lookups use the new key.
    const existingPayload = JSON.parse(existing.payload) as Record<
      string,
      unknown
    >;
    const needsPayloadUpdate = !existingPayload.triggerGroup;
    db.update(memoryJobs)
      .set({
        runAfter,
        updatedAt: Date.now(),
        ...(needsPayloadUpdate
          ? {
              payload: JSON.stringify({ ...existingPayload, ...payload }),
            }
          : {}),
      })
      .where(eq(memoryJobs.id, existing.id))
      .run();
  } else {
    enqueueMemoryJob("conversation_analyze", payload, runAfter, dbOverride);
  }

  // When an immediate trigger fires (batch/compaction), cancel any pending
  // debounced row for the same conversation — the immediate analysis covers
  // those messages, making the debounced pass redundant. Without this, both
  // rows fire independently and double the LLM cost per batch crossing.
  if (payload.triggerGroup === "immediate") {
    db.update(memoryJobs)
      .set({ status: "completed", updatedAt: Date.now() })
      .where(
        and(
          eq(memoryJobs.type, "conversation_analyze"),
          eq(memoryJobs.status, "pending"),
          sql`json_extract(${memoryJobs.payload}, '$.conversationId') = ${payload.conversationId}`,
          sql`json_extract(${memoryJobs.payload}, '$.triggerGroup') = 'debounced'`,
        ),
      )
      .run();
  }
}

/**
 * Upsert a pending `memory_retrospective` job keyed by `conversationId`. All
 * four retrospective triggers (interval, message_count, compaction,
 * lifecycle) collapse into a single pending row per conversation — rapid
 * triggers coalesce instead of double-firing. The `runAfter` parameter on a
 * follow-up enqueue overwrites the existing row's `runAfter` so a sooner
 * trigger can pull a later-scheduled job earlier; a later-scheduled trigger
 * does NOT push a sooner-scheduled row further out (consumer takes the
 * minimum). The trigger metadata is intentionally not retained — it is only
 * useful for observability at enqueue time.
 */
export function upsertMemoryRetrospectiveJob(
  payload: { conversationId: string },
  runAfter: number = Date.now(),
  dbOverride?: Parameters<DrizzleDb["transaction"]>[0] extends (
    tx: infer T,
  ) => unknown
    ? T
    : never,
): void {
  const db = dbOverride ?? memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "memory_retrospective"),
        eq(memoryJobs.status, "pending"),
        sql`json_extract(${memoryJobs.payload}, '$.conversationId') = ${payload.conversationId}`,
      ),
    )
    .get();
  if (existing) {
    // Take the minimum of the existing and incoming runAfter so the earliest
    // trigger always wins. A later trigger never pushes work further out.
    const nextRunAfter = Math.min(existing.runAfter, runAfter);
    if (nextRunAfter !== existing.runAfter) {
      db.update(memoryJobs)
        .set({ runAfter: nextRunAfter, updatedAt: Date.now() })
        .where(eq(memoryJobs.id, existing.id))
        .run();
    }
    return;
  }
  enqueueMemoryJob("memory_retrospective", payload, runAfter, dbOverride);
}

/**
 * Check whether a pending or running job of the given type already exists.
 * Used to prevent duplicate enqueues for long-running maintenance jobs.
 */
export function hasActiveJobOfType(type: MemoryJobType): boolean {
  const db = memoryDb();
  return (
    db
      .select({ id: memoryJobs.id })
      .from(memoryJobs)
      .where(
        and(
          eq(memoryJobs.type, type),
          inArray(memoryJobs.status, ["pending", "running"]),
        ),
      )
      .get() != null
  );
}

export function enqueuePruneOldLlmRequestLogsJob(retentionMs?: number): string {
  const db = memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "prune_old_llm_request_logs"),
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
      retentionMs >= 0
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
            updatedAt: Date.now(),
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
    retentionMs >= 0
      ? { retentionMs }
      : {};
  return enqueueMemoryJob("prune_old_llm_request_logs", payload);
}

export function enqueuePruneOldConversationsJob(
  retentionDays?: number,
): string {
  const db = memoryDb();
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

export function enqueuePruneOldTraceEventsJob(retentionDays?: number): string {
  const db = memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "prune_old_trace_events"),
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
  return enqueueMemoryJob("prune_old_trace_events", payload);
}

export interface LaneBudgets {
  slowLlm: number;
  fast: number;
  embed: number;
}

/**
 * Which slice of the queue {@link claimMemoryJobs} is allowed to claim:
 *
 * - `"all"` — every pending job (the daemon's in-process worker when no
 *   out-of-process worker owns the queue).
 * - `"core"` — every core (non-`plugin:`-prefixed) job, never plugin jobs. The
 *   standalone worker process uses this: it runs no plugin init, so it has no
 *   handler for a `plugin:` type and would hard-fail one with "Unknown memory
 *   job type". Excluding them at claim time leaves them pending for the daemon.
 * - `"plugin"` — only `plugin:`-prefixed jobs. The daemon's in-process worker
 *   uses this while the out-of-process worker owns the core queue, so plugin
 *   jobs still drain in the one process whose plugin init registered their
 *   handlers.
 */
export type JobClaimMode = "all" | "core" | "plugin";

/**
 * SQL predicate restricting `memory_jobs.type` to the slice a {@link
 * JobClaimMode} owns: the `plugin:` prefix in `"plugin"` mode, everything but
 * that prefix in `"core"` mode, and no restriction (`undefined`) in `"all"`.
 */
function jobTypeScope(claimMode: JobClaimMode) {
  if (claimMode === "plugin")
    return like(memoryJobs.type, PLUGIN_JOB_TYPE_LIKE);
  if (claimMode === "core")
    return notLike(memoryJobs.type, PLUGIN_JOB_TYPE_LIKE);
  return undefined;
}

export function claimMemoryJobs(
  limits: LaneBudgets,
  claimMode: JobClaimMode = "all",
): MemoryJob[] {
  if (limits.slowLlm <= 0 && limits.fast <= 0 && limits.embed <= 0) return [];

  const db = memoryDb();
  const now = Date.now();
  const pendingFilter = and(
    eq(memoryJobs.status, "pending"),
    lte(memoryJobs.runAfter, now),
  );

  // Plugin jobs are core-union-foreign string types, so they fall in neither
  // the slow nor the embed set — they only ever land in the fast lane. So in
  // `"plugin"` mode the slow and embed lanes are skipped wholesale, and the
  // fast lane is restricted to the `plugin:` prefix; in `"core"` mode the fast
  // lane excludes that prefix; in `"all"` mode no prefix filter applies.
  const claimSlowEmbed = claimMode !== "plugin";

  // Slow lane: long-running LLM jobs (graph extract/consolidate, analysis, etc.).
  const slowCandidates =
    claimSlowEmbed && limits.slowLlm > 0
      ? db
          .select()
          .from(memoryJobs)
          .where(
            and(pendingFilter, inArray(memoryJobs.type, SLOW_LLM_JOB_TYPES)),
          )
          .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
          .limit(limits.slowLlm)
          .all()
      : [];

  // Fast lane: everything that is neither slow-LLM nor embed. The `plugin:`
  // prefix scope routes plugin jobs to the worker lane that can handle them.
  const pluginPrefixFilter = jobTypeScope(claimMode);
  const fastCandidates =
    limits.fast > 0
      ? db
          .select()
          .from(memoryJobs)
          .where(
            and(
              pendingFilter,
              notInArray(memoryJobs.type, SLOW_LLM_JOB_TYPES),
              notInArray(memoryJobs.type, EMBED_JOB_TYPES),
              ...(pluginPrefixFilter ? [pluginPrefixFilter] : []),
            ),
          )
          .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
          .limit(limits.fast)
          .all()
      : [];

  // Embed lane: gated by both the Qdrant circuit breaker and the billing
  // breaker. When either breaker is open, skip embed jobs entirely — they
  // would just be claimed → fail → deferred, wasting CPU cycles. Exception:
  // if the cooldown has elapsed (breaker ready for probe), allow exactly
  // 1 embed job through so the breaker can self-heal.
  const qdrantBreakerOpen = isQdrantBreakerOpen();
  const qdrantProbeAllowed = qdrantBreakerOpen && shouldAllowQdrantProbe();
  const billingBreakerOpen = isEmbeddingBillingBreakerOpen();
  const billingProbeAllowed = !billingBreakerOpen && shouldAllowBillingProbe();
  const skipEmbedJobs =
    (qdrantBreakerOpen && !qdrantProbeAllowed) ||
    (billingBreakerOpen && !billingProbeAllowed);
  const probeAllowed = qdrantProbeAllowed || billingProbeAllowed;
  const embedLimit = probeAllowed ? Math.min(1, limits.embed) : limits.embed;

  if (skipEmbedJobs && limits.embed > 0) {
    if (billingBreakerOpen) {
      log.debug(
        "Skipping embed job claims — embedding billing breaker is open",
      );
    } else {
      log.debug("Skipping embed job claims — Qdrant circuit breaker is open");
    }
  }
  if (probeAllowed && limits.embed > 0) {
    log.debug("Allowing 1 embed probe job — breaker cooldown elapsed");
  }

  const embedCandidates =
    claimSlowEmbed && embedLimit > 0 && !skipEmbedJobs
      ? db
          .select()
          .from(memoryJobs)
          .where(and(pendingFilter, inArray(memoryJobs.type, EMBED_JOB_TYPES)))
          .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
          .limit(embedLimit)
          .all()
      : [];

  const candidates = [...slowCandidates, ...fastCandidates, ...embedCandidates];

  const claimed: MemoryJob[] = [];
  for (const row of candidates) {
    db.update(memoryJobs)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(and(eq(memoryJobs.id, row.id), eq(memoryJobs.status, "pending")))
      .run();
    if (rawMemoryChanges() === 0) continue;
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
  const db = memoryDb();
  db.update(memoryJobs)
    .set({ status: "completed", updatedAt: Date.now(), lastError: null })
    .where(eq(memoryJobs.id, id))
    .run();
}

/** Max times a job can be deferred before it is marked as failed. */
const MAX_DEFERRALS = 50;
/** Log warnings at these milestone counts to avoid flooding logs. */
const DEFERRAL_WARN_MILESTONES = [40, 45];
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
  const db = memoryDb();
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

  // Log at milestones only (40, 45) to avoid flooding logs.
  // At 50, the job fails via the check above, so 40 and 45 are the warnings.
  if (DEFERRAL_WARN_MILESTONES.includes(deferrals)) {
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
  const db = memoryDb();
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

/**
 * Reset `running` jobs back to `pending` so a fresh drainer can re-claim work a
 * crashed predecessor left mid-flight. `claimMode` scopes the reset to the
 * slice this drainer owns so two concurrently-active drainers (the daemon's
 * plugin lane + the out-of-process core worker) don't reset each other's
 * in-flight jobs at startup: the core worker resets core jobs only, leaving
 * plugin jobs the daemon may be running untouched.
 */
export function resetRunningJobsToPending(
  claimMode: JobClaimMode = "all",
): number {
  const db = memoryDb();
  const scope = jobTypeScope(claimMode);
  db.update(memoryJobs)
    .set({ status: "pending", updatedAt: Date.now() })
    .where(
      scope
        ? and(eq(memoryJobs.status, "running"), scope)
        : eq(memoryJobs.status, "running"),
    )
    .run();
  return rawMemoryChanges();
}

/**
 * Fail running jobs whose `startedAt` is older than `timeoutMs` ago.
 * Returns the number of jobs that were timed out.
 *
 * `claimMode` scopes the sweep to the slice this drainer owns — the same
 * `plugin:`-prefix predicate the claim ({@link claimMemoryJobs}) and reset
 * ({@link resetRunningJobsToPending}) paths use. In split-worker mode (the
 * daemon's plugin lane running alongside the out-of-process core worker) each
 * process must only time out the jobs IT runs, or one would fail the other's
 * legitimately in-flight job after the timeout. `"all"` (the default) sweeps the
 * whole queue, matching the single-drainer case.
 */
export function failStalledJobs(
  timeoutMs: number,
  claimMode: JobClaimMode = "all",
): number {
  const now = Date.now();
  const cutoff = now - timeoutMs;
  // Mirror `jobTypeScope` as raw SQL (the SELECT is hand-written): `LIKE` in
  // `"plugin"` mode, `NOT LIKE` in `"core"` mode, no restriction in `"all"`.
  const typePredicate =
    claimMode === "plugin"
      ? "AND type LIKE ?"
      : claimMode === "core"
        ? "AND type NOT LIKE ?"
        : "";
  const params: Array<number | string> =
    claimMode === "all" ? [cutoff] : [cutoff, PLUGIN_JOB_TYPE_LIKE];
  const stalled = rawMemoryAll<{ id: string; type: string }>(
    `
    SELECT id, type
    FROM memory_jobs
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at < ?
      ${typePredicate}
  `,
    ...params,
  );
  if (stalled.length === 0) return 0;

  const db = memoryDb();
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
  const rows = rawMemoryAll<{ status: string; c: number }>(`
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
