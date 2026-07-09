import { and, asc, eq, inArray, lte, notInArray, or, sql } from "drizzle-orm";
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
  | "prune_old_tool_invocations"
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
  | "pkb_filing"
  | "pkb_compaction"
  | "index_message_lexical"
  | "purge_conversation_lexical"
  | "delete_message_lexical"
  | "backfill_lexical_index"
  | "skill_card_insert"
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

/**
 * Job types that power message-content lexical search — host infrastructure
 * that shares the background job queue but is not a memory feature. The worker
 * keeps draining exactly these types while memory is disabled, so message
 * search stays indexed regardless of the memory feature's state.
 */
export const MESSAGE_LEXICAL_JOB_TYPES: MemoryJobType[] = [
  "index_message_lexical",
  "purge_conversation_lexical",
  "delete_message_lexical",
  "backfill_lexical_index",
];

export const SLOW_LLM_JOB_TYPES: MemoryJobType[] = [
  "graph_consolidate",
  "pkb_filing",
  "pkb_compaction",
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
 * Upsert a pending `skill_card_insert` job — the deferred delivery of a
 * retrospective run's skill card into a source conversation that was mid-turn
 * at insert time (see `memory-retrospective-skill-card.ts`). Keyed by
 * `runConversationId`: one pending delivery exists per authoring run, so the
 * handler's own still-mid-turn re-upsert (and any duplicate enqueue) coalesces
 * into a single row instead of stacking deliveries — the message-level
 * `clientMessageId` dedup remains the final backstop against a double card.
 * The earliest `runAfter` wins, mirroring `upsertMemoryRetrospectiveJob`; the
 * stored payload is kept as-is since every enqueue for a given run carries the
 * same snapshot (the skill list is derived from that run's persisted
 * messages).
 */
export function upsertSkillCardInsertJob(
  payload: {
    sourceConversationId: string;
    runConversationId: string;
  } & Record<string, unknown>,
  runAfter: number = Date.now(),
): void {
  const db = memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "skill_card_insert"),
        eq(memoryJobs.status, "pending"),
        sql`json_extract(${memoryJobs.payload}, '$.runConversationId') = ${payload.runConversationId}`,
      ),
    )
    .get();
  if (existing) {
    const nextRunAfter = Math.min(existing.runAfter, runAfter);
    if (nextRunAfter !== existing.runAfter) {
      db.update(memoryJobs)
        .set({ runAfter: nextRunAfter, updatedAt: Date.now() })
        .where(eq(memoryJobs.id, existing.id))
        .run();
    }
    return;
  }
  enqueueMemoryJob("skill_card_insert", payload, runAfter);
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

export function enqueuePruneOldToolInvocationsJob(
  retentionDays?: number,
): string {
  const db = memoryDb();
  const existing = db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "prune_old_tool_invocations"),
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
  return enqueueMemoryJob("prune_old_tool_invocations", payload);
}

export interface LaneBudgets {
  slowLlm: number;
  fast: number;
  embed: number;
}

/**
 * Claim up to the per-lane budgets of pending jobs. When `restrictToTypes` is
 * provided, only jobs of those types are eligible in every lane — the worker
 * uses this to drain exclusively the message-lexical types while memory is
 * disabled.
 */
export function claimMemoryJobs(
  limits: LaneBudgets,
  restrictToTypes?: readonly MemoryJobType[],
): MemoryJob[] {
  if (limits.slowLlm <= 0 && limits.fast <= 0 && limits.embed <= 0) {
    return [];
  }

  const db = memoryDb();
  const now = Date.now();
  const restrictFilter = restrictToTypes
    ? inArray(memoryJobs.type, [...restrictToTypes])
    : undefined;
  const pendingFilter = and(
    eq(memoryJobs.status, "pending"),
    lte(memoryJobs.runAfter, now),
    restrictFilter,
  );

  // Slow lane: long-running LLM jobs (graph extract/consolidate, analysis, etc.).
  const slowCandidates =
    limits.slowLlm > 0
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

  // Fast lane: everything that is neither slow-LLM nor embed.
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
    embedLimit > 0 && !skipEmbedJobs
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
    if (rawMemoryChanges() === 0) {
      continue;
    }
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
  if (!row) {
    return "failed";
  }

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
  if (!row) {
    return;
  }
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
  const db = memoryDb();
  db.update(memoryJobs)
    .set({ status: "pending", updatedAt: Date.now() })
    .where(eq(memoryJobs.status, "running"))
    .run();
  return rawMemoryChanges();
}

/**
 * Fail running jobs whose `startedAt` is older than `timeoutMs` ago.
 * Returns the number of jobs that were timed out.
 */
export function failStalledJobs(timeoutMs: number): number {
  const now = Date.now();
  const cutoff = now - timeoutMs;
  const stalled = rawMemoryAll<{ id: string; type: string }>(
    "jobs:failStalledJobs:select",
    `
    SELECT id, type
    FROM memory_jobs
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at < ?
  `,
    cutoff,
  );
  if (stalled.length === 0) {
    return 0;
  }

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
  const rows = rawMemoryAll<{ status: string; c: number }>(
    "jobs:getMemoryJobCounts",
    `
    SELECT status, COUNT(*) AS c
    FROM memory_jobs
    GROUP BY status
  `,
  );
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
