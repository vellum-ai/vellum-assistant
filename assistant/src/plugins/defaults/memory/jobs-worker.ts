import { join } from "node:path";

import { getConfig } from "../../../config/loader.js";
import { isMemoryV3Live } from "../../../config/memory-v3-gate.js";
import type { AssistantConfig } from "../../../config/types.js";
import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../../../daemon/disk-pressure-background-gate.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../persistence/checkpoints.js";
import {
  type CleanupJobKind,
  getLastScheduledCleanupEnqueueMs,
  markScheduledCleanupEnqueued,
} from "../../../persistence/cleanup-schedule-state.js";
import {
  maybeRunDbMaintenance,
  maybeRunPassiveWalCheckpoint,
} from "../../../persistence/db-maintenance.js";
import {
  EmbeddingBillingBlockError,
  extractHttpStatus,
  recordBillingBlock,
} from "../../../persistence/embeddings/embedding-billing-breaker.js";
import { QdrantCircuitOpenError } from "../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  BackendUnavailableError,
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "../../../persistence/job-utils.js";
import {
  claimMemoryJobs,
  completeMemoryJob,
  deferMemoryJob,
  EMBED_JOB_TYPES,
  enqueueMemoryJob,
  enqueuePruneOldConversationsJob,
  enqueuePruneOldLlmRequestLogsJob,
  enqueuePruneOldToolInvocationsJob,
  failMemoryJob,
  failStalledJobs,
  hasActiveJobOfType,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS,
  type MemoryJob,
  type MemoryJobType,
  MESSAGE_LEXICAL_JOB_TYPES,
  resetRunningJobsToPending,
  SLOW_LLM_JOB_TYPES,
} from "../../../persistence/jobs-store.js";
import { spawnMemoryWorkerProcess } from "../../../persistence/worker-control.js";
import type { JobHandler } from "../../types.js";
import { getLogger } from "./logging.js";
import { sweepOrphanMemoryRetrospectiveConversations } from "./memory-retrospective-startup-cleanup.js";
import { getWorkspaceDir } from "./paths.js";
import { hasPkbBufferContent } from "./pkb-schedule.js";
import { countBufferLines } from "./v2/consolidation-job.js";

const log = getLogger("memory-jobs-worker");

const jobHandlers = new Map<string, JobHandler>();

/**
 * Register a handler for a job type. Later registrations overwrite earlier ones
 * for the same type.
 */
export function registerJobHandler(type: string, handler: JobHandler): void {
  jobHandlers.set(type, handler);
}

const AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD = {
  trigger: MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS.automatic,
} as const;

/**
 * Minimum buffer entries required for a scheduled consolidation run. The
 * time-based schedule noops when `memory/buffer.md` has fewer non-empty lines
 * than this threshold — the LLM cost of a full consolidation pass outweighs
 * the benefit when the buffer is nearly empty. Mirrors the heartbeat
 * max-consecutive-runs skip pattern. Manual "Run now" and the size-based
 * trigger are not affected.
 */
export const MIN_BUFFER_LINES_FOR_CONSOLIDATION = 10;

/**
 * V1 job types that read or write the v1 Qdrant collection via
 * `getQdrantClient()`. When `memory.v2.enabled` is true, the v1 client is
 * intentionally left uninitialized in `lifecycle.ts`, so these handlers would
 * throw `BackendUnavailableError` and accumulate as a deferred backlog. Stale
 * rows from indexer.ts and other unguarded enqueue sites must short-circuit
 * here for the same reason `graph_extract` does below.
 */
const V1_QDRANT_JOB_TYPES = new Set<MemoryJobType>([
  "embed_segment",
  "embed_summary",
  "embed_media",
  "embed_attachment",
  "embed_graph_node",
  "embed_pkb_file",
  "rebuild_index",
  "delete_qdrant_vectors",
]);

/**
 * Job types whose handlers have been removed. Existing rows may still sit in
 * the database — the worker completes them silently instead of throwing.
 */
const LEGACY_JOB_TYPES = new Set([
  "embed_item",
  "extract_items",
  "batch_extract",
  "extract_entities",
  "cleanup_stale_superseded_items",
  "backfill_entity_relations",
  "refresh_weekly_summary",
  "refresh_monthly_summary",
  "journal_carry_forward",
  "generate_capability_cards",
  "generate_thread_starters",
  "memory_v2_rebuild_edges",
  // Retired memory-v3 job types — handlers were removed in the v3 rip. Kept
  // here so pre-upgrade rows enqueued by the old write path drop gracefully.
  "memory_v3_consolidate",
  "memory_v3_index_maintenance",
  "memory_v3_edge_learning",
  "memory_proc_distill",
  // Retired analyze-conversation job type — pre-upgrade pending rows drop
  // gracefully.
  "conversation_analyze",
]);

export const POLL_INTERVAL_MIN_MS = 1_500;
export const POLL_INTERVAL_MAX_MS = 30_000;

export interface MemoryJobsWorker {
  runOnce(): Promise<number>;
  stop(): void;
}

/**
 * Daemon-lifecycle entry point: spawn the memory jobs worker as a child of the
 * daemon (`detached: false`, so it appears in `assistant ps` and is torn down
 * on shutdown). The worker process is the sole drainer of the memory job queue.
 * Fire-and-forget — a worker failure must never block boot. A worker that comes
 * up late is still the desired sole drainer, so `terminateOnTimeout` is
 * deliberately not set.
 *
 * This must not be used as the standalone worker process's entry — that would
 * recurse and fork-bomb. `worker.ts` calls {@link startMemoryJobsWorkerLoop}
 * directly.
 */
export function startMemoryJobsWorker(): void {
  void spawnMemoryWorkerProcess({
    terminateOnTimeout: false,
    detached: false,
  })
    .then(({ pid, alreadyRunning }) =>
      log.info(
        { pid, alreadyRunning },
        alreadyRunning
          ? "Memory worker process already running — reusing it"
          : "Memory worker process started",
      ),
    )
    .catch((err) => log.warn({ err }, "Failed to start memory worker process"));
}

/**
 * Run the memory jobs worker loop on the caller's event loop: poll for
 * claimable jobs with adaptive backoff until {@link MemoryJobsWorker.stop} is
 * called. This is the worker loop itself, driven by the standalone worker
 * process (`worker.ts`).
 */
export function startMemoryJobsWorkerLoop(): MemoryJobsWorker {
  const recovered = resetRunningJobsToPending();
  if (recovered > 0) {
    log.info({ recovered }, "Recovered stale running memory jobs");
  }

  // Restore each cleanup job's cadence from its persisted checkpoint so a
  // restart resumes counting from the last enqueue instead of re-firing every
  // job on boot. Runs after resetRunningJobsToPending (which has already
  // touched the DB), so migrations are settled. Best-effort: on failure the
  // throttle stays at 0 and jobs fire on the first tick (the pre-persistence
  // behavior), which is a safe degradation.
  try {
    seedCleanupScheduleFromCheckpoints();
  } catch (err) {
    log.warn(
      { err },
      "Failed to seed cleanup schedule from checkpoints; jobs will fire on the first tick",
    );
  }

  // After running-job recovery (so legitimate in-flight retries aren't
  // swept), clean up orphan memory-retrospective background conversations
  // left behind by daemon crashes mid-job. Best-effort and detached — worker
  // startup never blocks on the sweep, and failures only log. Concurrent
  // ticking is safe: the sweep reads the active-job set and the orphan
  // candidates in one synchronous block after its awaited baseline loads, so
  // a retrospective forked by a mid-sweep tick is protected by its
  // pending/running job.
  void sweepOrphanMemoryRetrospectiveConversations().catch((err: unknown) => {
    log.warn(
      { err },
      "Memory-retrospective startup cleanup failed; continuing worker startup",
    );
  });

  let stopped = false;
  let tickRunning = false;
  let timer: ReturnType<typeof setTimeout>;
  let currentIntervalMs = POLL_INTERVAL_MIN_MS;

  const tick = async () => {
    if (stopped || tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      const processed = await runMemoryJobsOnce({
        enableScheduledCleanup: true,
      });
      if (processed > 0) {
        // Per-tick claim budget equals the lane caps, so when a tick
        // processed work the next tick must run immediately to drain any
        // remaining backlog. Holding the 1.5s floor between ticks would cap
        // sustained throughput at lane-cap jobs per 1.5s and starve large
        // backlogs of short jobs.
        currentIntervalMs = 0;
      } else {
        currentIntervalMs = Math.min(
          Math.max(currentIntervalMs * 2, POLL_INTERVAL_MIN_MS),
          POLL_INTERVAL_MAX_MS,
        );
      }
    } catch (err) {
      log.error({ err }, "Memory worker tick failed");
      currentIntervalMs = Math.min(
        Math.max(currentIntervalMs * 2, POLL_INTERVAL_MIN_MS),
        POLL_INTERVAL_MAX_MS,
      );
    } finally {
      tickRunning = false;
    }
  };

  const scheduleTick = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick().then(() => {
        if (!stopped) {
          scheduleTick();
        }
      });
    }, currentIntervalMs);
    (timer as NodeJS.Timeout).unref?.();
  };

  void tick().then(() => {
    if (!stopped) {
      scheduleTick();
    }
  });

  return {
    async runOnce(): Promise<number> {
      return runMemoryJobsOnce({ enableScheduledCleanup: true });
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

type ProcessGroup = (group: MemoryJob[]) => Promise<number>;

export async function runMemoryJobsOnce(
  options: { enableScheduledCleanup?: boolean } = {},
): Promise<number> {
  const config = getConfig();
  // While memory is disabled the queue still drains the MESSAGE-LEXICAL job
  // types — host-owned message-search indexing that shares this queue but is
  // not a memory feature. Every memory lane and every maintenance enqueue
  // stays idle in that state; only the lexical types are claimable.
  const memoryEnabled = config.memory.enabled !== false;
  const enableScheduledCleanup =
    options.enableScheduledCleanup === true && memoryEnabled;

  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "skip") {
    if (shouldLogDiskPressureBackgroundSkip("memory-jobs-worker")) {
      log.warn(
        {
          source: "memory",
          ...diskPressureBackgroundSkipLogFields(diskPressureGate),
        },
        "Memory jobs worker skipped during disk pressure cleanup mode",
      );
    }
    return 0;
  }

  // Fail jobs that have been running longer than the configured timeout
  const timedOut = failStalledJobs(config.memory.jobs.stalledJobTimeoutMs);
  if (timedOut > 0) {
    log.warn({ timedOut }, "Timed out stalled memory jobs");
  }

  const cfgSlow = Math.max(1, config.memory.jobs.slowLlmConcurrency);
  const cfgFast = Math.max(1, config.memory.jobs.fastConcurrency);
  const cfgEmbed = Math.max(1, config.memory.jobs.embedConcurrency);

  // Claim per-lane budgets so a backlog of slow LLM jobs cannot starve fast
  // jobs (and vice versa). The Qdrant circuit breaker still gates only the
  // embed lane inside `claimMemoryJobs`. With memory disabled, the slow and
  // embed lanes get no budget and the fast lane is restricted to the
  // message-lexical types (they ride the fast lane).
  const claimed = claimMemoryJobs(
    {
      slowLlm: memoryEnabled ? cfgSlow : 0,
      fast: cfgFast,
      embed: memoryEnabled ? cfgEmbed : 0,
    },
    memoryEnabled ? undefined : MESSAGE_LEXICAL_JOB_TYPES,
  );

  if (claimed.length === 0) {
    if (enableScheduledCleanup) {
      maybeEnqueueScheduledCleanupJobs(config);
    }
    maybeEnqueueGraphMaintenanceJobs(config);
    if (memoryEnabled) {
      await maybeRunDbMaintenance();
      await maybeRunPassiveWalCheckpoint();
    }
    return 0;
  }

  const slowSet = new Set<MemoryJobType>(SLOW_LLM_JOB_TYPES);
  const embedSet = new Set<MemoryJobType>(EMBED_JOB_TYPES);
  const slowJobs: MemoryJob[] = [];
  const fastJobs: MemoryJob[] = [];
  const embedJobs: MemoryJob[] = [];
  for (const job of claimed) {
    if (slowSet.has(job.type)) {
      slowJobs.push(job);
    } else if (embedSet.has(job.type)) {
      embedJobs.push(job);
    } else {
      fastJobs.push(job);
    }
  }

  const processGroup: ProcessGroup = async (group) => {
    let groupProcessed = 0;
    for (const job of group) {
      try {
        await processJob(job, config);
        completeMemoryJob(job.id);
        groupProcessed += 1;
      } catch (err) {
        try {
          handleJobError(job, err);
        } catch (handlerErr) {
          log.error(
            { err: handlerErr, jobId: job.id, type: job.type },
            "handleJobError itself threw, job left in running status",
          );
        }
        // A billing block (402) is deterministic — every subsequent embed
        // call will fail identically. Defer the remaining embed jobs in
        // this batch instead of burning a network round-trip on each one.
        if (
          err instanceof EmbeddingBillingBlockError ||
          (embedSet.has(job.type) && extractHttpStatus(err) === 402)
        ) {
          for (const remaining of group.slice(group.indexOf(job) + 1)) {
            deferMemoryJob(remaining.id);
          }
          break;
        }
      }
    }
    return groupProcessed;
  };

  // Run all three lanes in parallel. Each lane runs its own bounded task pool
  // so a slow `graph_consolidate` cannot block embed or fast jobs from making
  // progress, and per-`(type, conversationId)` grouping inside each lane keeps
  // same-conversation jobs serialized.
  const [slowProcessed, fastProcessed, embedProcessed] = await Promise.all([
    runLanePool(slowJobs, cfgSlow, processGroup),
    runLanePool(fastJobs, cfgFast, processGroup),
    runLanePool(embedJobs, cfgEmbed, processGroup),
  ]);

  if (enableScheduledCleanup) {
    maybeEnqueueScheduledCleanupJobs(config);
  }
  maybeEnqueueGraphMaintenanceJobs(config);
  await maybeRunDbMaintenance();
  await maybeRunPassiveWalCheckpoint();
  return slowProcessed + fastProcessed + embedProcessed;
}

/**
 * Run a single lane's jobs through a bounded task pool of size `concurrency`.
 *
 * Jobs targeting different conversations (via payload.conversationId) are
 * placed in separate groups and run in parallel up to the lane's concurrency
 * cap. Jobs targeting the same conversation — or global jobs without a
 * conversationId — share a group and run sequentially to avoid checkpoint
 * races.
 */
async function runLanePool(
  jobs: MemoryJob[],
  concurrency: number,
  processGroup: ProcessGroup,
): Promise<number> {
  if (jobs.length === 0) {
    return 0;
  }

  const groups = new Map<string, MemoryJob[]>();
  for (const job of jobs) {
    const convId =
      typeof job.payload.conversationId === "string"
        ? job.payload.conversationId
        : null;
    const groupKey = convId ? `${job.type}:${convId}` : job.type;
    let group = groups.get(groupKey);
    if (!group) {
      group = [];
      groups.set(groupKey, group);
    }
    group.push(job);
  }

  let processed = 0;
  const typeGroups = [...groups.values()];

  if (typeGroups.length <= concurrency) {
    const results = await Promise.allSettled(typeGroups.map(processGroup));
    for (const result of results) {
      if (result.status === "fulfilled") {
        processed += result.value;
      } else {
        log.error(
          { err: result.reason },
          "Memory job group rejected unexpectedly — jobs in this batch may have been dropped",
        );
      }
    }
    return processed;
  }

  // Task pool: keep `concurrency` groups in flight at all times so a new group
  // starts the instant any slot frees up.
  let nextIdx = 0;
  const startNext = (): Promise<void> | undefined => {
    if (nextIdx >= typeGroups.length) {
      return undefined;
    }
    const group = typeGroups[nextIdx++]!;
    return processGroup(group)
      .then(
        (count) => {
          processed += count;
        },
        (err) => {
          log.error(
            { err },
            "Memory job group rejected unexpectedly — jobs in this batch may have been dropped",
          );
        },
      )
      .then(() => startNext());
  };

  const workers = Array.from(
    { length: Math.min(concurrency, typeGroups.length) },
    () => startNext()!,
  );
  await Promise.all(workers);
  return processed;
}

// ── Job error handling ─────────────────────────────────────────────

function handleJobError(job: MemoryJob, err: unknown): void {
  if (err instanceof EmbeddingBillingBlockError) {
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Billing breaker open, job exceeded max deferrals",
      );
    } else {
      log.debug(
        { jobId: job.id, type: job.type },
        "Billing breaker open, deferring job",
      );
    }
    return;
  }

  // Detect 402 billing exhaustion from any embedding backend and trip the
  // billing breaker so subsequent embed jobs short-circuit at claim time.
  if (EMBED_JOB_TYPES.includes(job.type) && extractHttpStatus(err) === 402) {
    recordBillingBlock();
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Embedding billing block (402), job exceeded max deferrals",
      );
    } else {
      log.warn(
        { jobId: job.id, type: job.type },
        "Embedding billing block (402), deferring job",
      );
    }
    return;
  }

  if (err instanceof BackendUnavailableError) {
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Embedding backend unavailable, job exceeded max deferrals",
      );
    } else {
      log.debug(
        { jobId: job.id, type: job.type },
        "Embedding backend unavailable, deferring job",
      );
    }
  } else if (err instanceof QdrantCircuitOpenError) {
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Qdrant circuit breaker open, job exceeded max deferrals",
      );
    } else {
      log.debug(
        { jobId: job.id, type: job.type },
        "Qdrant circuit breaker open, deferring job",
      );
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    const category = classifyError(err);
    if (category === "retryable") {
      const delay = retryDelayForAttempt(job.attempts + 1);
      failMemoryJob(job.id, message, {
        retryDelayMs: delay,
        maxAttempts: RETRY_MAX_ATTEMPTS,
      });
      log.warn(
        { err, jobId: job.id, type: job.type, delay, category },
        "Memory job failed (retryable)",
      );
    } else {
      failMemoryJob(job.id, message, { maxAttempts: 1 });
      log.warn(
        { err, jobId: job.id, type: job.type, category },
        "Memory job failed (fatal)",
      );
    }
  }
}

// ── Job dispatch ───────────────────────────────────────────────────

async function processJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  if (config.memory.v2.enabled && V1_QDRANT_JOB_TYPES.has(job.type)) {
    return;
  }
  const handler = jobHandlers.get(job.type);
  if (handler) {
    await handler(job, config);
    return;
  }

  const rawType = (job as { type: string }).type;
  if (LEGACY_JOB_TYPES.has(rawType)) {
    log.debug({ jobId: job.id, type: rawType }, "Dropping legacy job");
    return;
  }
  throw new Error(`Unknown memory job type: ${rawType}`);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CLEANUP_JOB_KINDS: readonly CleanupJobKind[] = [
  "conversations",
  "llm_request_logs",
  "tool_invocations",
];

const CLEANUP_ENQUEUE_CHECKPOINT_KEYS: Record<CleanupJobKind, string> = {
  conversations: "cleanup:last_enqueue:conversations",
  llm_request_logs: "cleanup:last_enqueue:llm_request_logs",
  tool_invocations: "cleanup:last_enqueue:tool_invocations",
};

/**
 * Seed the in-memory cleanup throttle from persisted checkpoints so each job's
 * cadence survives a daemon restart. Without this the throttle would start at 0
 * on every boot, re-firing every cleanup job immediately regardless of when it
 * last ran — which for a long retention window (e.g. 30-day conversation
 * pruning) turns a frequent restart cycle into a prune on every boot.
 *
 * A job with no checkpoint (never enqueued on this instance) keeps its default
 * 0, so it fires once on the first tick and then persists its timestamp. On a
 * fresh instance that first prune is a harmless no-op (nothing is old enough to
 * delete yet); on an upgrade it clears whatever has already aged out.
 *
 * Must run after DB migrations settle — the worker startup path already
 * satisfies this (it touches the DB before calling here).
 */
export function seedCleanupScheduleFromCheckpoints(): void {
  for (const kind of CLEANUP_JOB_KINDS) {
    const raw = getMemoryCheckpoint(CLEANUP_ENQUEUE_CHECKPOINT_KEYS[kind]);
    if (raw === null) {
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      markScheduledCleanupEnqueued(kind, parsed);
    }
  }
}

/**
 * Record that a cleanup job for `kind` was just enqueued: advance the in-memory
 * throttle and persist the timestamp so the cadence survives a restart. A
 * config-driven throttle reset (ConfigWatcher) only clears the in-memory value;
 * the next enqueue re-persists here, so the checkpoint self-heals on the tick
 * after a retention change.
 */
function recordCleanupEnqueued(kind: CleanupJobKind, nowMs: number): void {
  markScheduledCleanupEnqueued(kind, nowMs);
  setMemoryCheckpoint(CLEANUP_ENQUEUE_CHECKPOINT_KEYS[kind], String(nowMs));
}

/**
 * Enqueue periodic cleanup jobs, each on a cadence equal to its own retention
 * window. A job that keeps data for N is re-enqueued at most once per N:
 * pruning that retains LLM logs for 1h runs hourly, pruning that retains
 * conversations for 30d runs every 30d. Each job's throttle is tracked
 * independently in cleanup-schedule-state (and persisted via checkpoints so the
 * cadence survives restarts), and enqueue is deduped in jobs-store, so repeated
 * calls remain safe.
 *
 * Exported for tests; the worker calls it on every idle/drain tick.
 *
 * Returns true if at least one job was enqueued this call.
 */
export function maybeEnqueueScheduledCleanupJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): boolean {
  const cleanup = config.memory.cleanup;
  if (!cleanup.enabled) {
    return false;
  }

  // A job is due when at least its full retention window has elapsed since the
  // last enqueue for that job. The throttle is seeded from a persisted
  // checkpoint at startup and reset to 0 when ConfigWatcher observes a
  // retention change, so a due job also fires promptly after a config change
  // while an unchanged one resumes its cadence across restarts.
  const isDue = (kind: CleanupJobKind, intervalMs: number): boolean =>
    nowMs - getLastScheduledCleanupEnqueueMs(kind) >= intervalMs;

  let enqueuedAny = false;

  if (
    cleanup.conversationRetentionDays > 0 &&
    isDue("conversations", cleanup.conversationRetentionDays * MS_PER_DAY)
  ) {
    const jobId = enqueuePruneOldConversationsJob(
      cleanup.conversationRetentionDays,
    );
    recordCleanupEnqueued("conversations", nowMs);
    enqueuedAny = true;
    log.debug(
      { jobId, retentionDays: cleanup.conversationRetentionDays },
      "Enqueued scheduled prune_old_conversations",
    );
  }

  if (
    cleanup.llmRequestLogRetentionMs !== null &&
    isDue("llm_request_logs", cleanup.llmRequestLogRetentionMs)
  ) {
    const jobId = enqueuePruneOldLlmRequestLogsJob(
      cleanup.llmRequestLogRetentionMs,
    );
    recordCleanupEnqueued("llm_request_logs", nowMs);
    enqueuedAny = true;
    log.debug(
      { jobId, retentionMs: cleanup.llmRequestLogRetentionMs },
      "Enqueued scheduled prune_old_llm_request_logs",
    );
  }

  // Audit-log (tool_invocations) retention is configured separately under
  // `auditLog.retentionDays`; its prune cadence follows that window.
  if (
    config.auditLog.retentionDays > 0 &&
    isDue("tool_invocations", config.auditLog.retentionDays * MS_PER_DAY)
  ) {
    const jobId = enqueuePruneOldToolInvocationsJob(
      config.auditLog.retentionDays,
    );
    recordCleanupEnqueued("tool_invocations", nowMs);
    enqueuedAny = true;
    log.debug(
      { jobId, retentionDays: config.auditLog.retentionDays },
      "Enqueued scheduled prune_old_tool_invocations",
    );
  }

  return enqueuedAny;
}

// ── Graph maintenance scheduling ──────────────────────────────────

const GRAPH_DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const GRAPH_CONSOLIDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const GRAPH_PATTERN_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GRAPH_NARRATIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
// Backstop cadence for v3 self-maintenance. The primary trigger is the
// post-consolidation follow-up (see `consolidation-job.ts`); this interval only
// covers the case where that follow-up is missed (enqueue failure). A
// conservative cadence is fine since
// the maintenance pass is idempotent and cheap when there's nothing to do.
const GRAPH_V3_MAINTAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const GRAPH_MAINTENANCE_CHECKPOINTS = {
  decay: "graph_maintenance:decay:last_run",
  consolidate: "graph_maintenance:consolidate:last_run",
  patternScan: "graph_maintenance:pattern_scan:last_run",
  narrative: "graph_maintenance:narrative:last_run",
  memoryV2Consolidate: "memory_v2_consolidate_last_run",
  memoryV3Maintain: "memory_v3_maintain_last_run",
  pkbFiling: "pkb_filing_last_run",
  pkbCompaction: "pkb_compaction_last_run",
} as const;

/**
 * Enqueue periodic graph maintenance jobs.
 *
 * Mutually exclusive between v1 and v2:
 *   - v2 active (`memory.v2.enabled` on) → only one buffer-drainer is
 *     scheduled (see below).
 *   - v2 inactive → the four v1 entries (decay, consolidate, pattern_scan,
 *     narrative) are scheduled instead.
 *
 * The `memory/buffer.md` is shared, so exactly one consolidator owns the drain
 * at a time. When v2 is active, the v2 consolidator (`memory_v2_consolidate`)
 * is the sole buffer-drainer.
 *
 * Read/write paths route to v2 when the flag is on, so v1 graph data goes
 * unread; running v1 maintenance alongside v2 is wasted compute and LLM
 * spend. The v1 code path remains live so flipping the flag back to off
 * fully re-engages v1.
 *
 * Uses durable checkpoints so intervals survive daemon restarts — jobs only
 * fire when the actual elapsed time since last run exceeds the interval.
 * Sweep is intentionally not on this schedule: it is debounced from the
 * live `graph_extract` trigger path (see `indexMessageNow` in `indexer.ts`)
 * so it runs on the same idle/message-count cadence.
 *
 * Independently of the v1/v2 split, a flag-gated `memory_v3_maintain` backstop
 * is appended when a v3 path is active so the topic tree self-heals even if the
 * primary post-consolidation follow-up enqueue is missed.
 */
/**
 * Whether `hour` falls inside the PKB jobs' configured active window. A `null`
 * bound on either side means no restriction. Windows may wrap midnight
 * (start > end, e.g. 22–6).
 */
function isWithinPkbActiveHours(
  hour: number,
  start: number | null,
  end: number | null,
): boolean {
  if (start == null || end == null) {
    return true;
  }
  if (start <= end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

/** Line count of the memory buffer, the scheduler's consolidation gate. */
function memoryBufferLineCount(): number {
  return countBufferLines(join(getWorkspaceDir(), "memory", "buffer.md"));
}

export function maybeEnqueueGraphMaintenanceJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): void {
  const memoryEnabled = config.memory.enabled !== false;
  if (!memoryEnabled) {
    return;
  }

  const v2Active = config.memory.v2.enabled;

  // The single buffer-drainer entry for the v2-active branch. Referenced again
  // below by the size-based trigger.
  const consolidateEntry = {
    key: GRAPH_MAINTENANCE_CHECKPOINTS.memoryV2Consolidate,
    intervalMs: config.memory.v2.consolidation_interval_hours * 60 * 60 * 1000,
    jobType: "memory_v2_consolidate" as MemoryJobType,
  };

  const schedule: Array<{
    key: string;
    intervalMs: number;
    jobType: MemoryJobType;
  }> = v2Active
    ? [consolidateEntry]
    : [
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.decay,
          intervalMs: GRAPH_DECAY_INTERVAL_MS,
          jobType: "graph_decay",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.consolidate,
          intervalMs: GRAPH_CONSOLIDATE_INTERVAL_MS,
          jobType: "graph_consolidate",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.patternScan,
          intervalMs: GRAPH_PATTERN_SCAN_INTERVAL_MS,
          jobType: "graph_pattern_scan",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.narrative,
          intervalMs: GRAPH_NARRATIVE_INTERVAL_MS,
          jobType: "graph_narrative_refine",
        },
      ];

  // v3 self-maintenance backstop. Orthogonal to the v1/v2 mutual exclusion
  // above: it owns its own checkpoint and operates on the v3 topic tree, so it
  // runs under either branch. Gated on the same config that gates the v3 plugin
  // so it stays inert when v3 is off. The post-consolidation follow-up in
  // `consolidation-job.ts` remains the primary trigger; this interval only
  // self-heals when that follow-up is missed (failed enqueue). The job handler
  // itself no-ops when v3 is off, so
  // this guard is belt-and-suspenders that also avoids a wasted enqueue.
  if (isMemoryV3Live(config)) {
    schedule.push({
      key: GRAPH_MAINTENANCE_CHECKPOINTS.memoryV3Maintain,
      intervalMs: GRAPH_V3_MAINTAIN_INTERVAL_MS,
      jobType: "memory_v3_maintain",
    });
  }

  let enqueuedConsolidate = false;
  for (const { key, intervalMs, jobType } of schedule) {
    const lastRun = parseInt(getMemoryCheckpoint(key) ?? "0", 10);
    if (nowMs - lastRun >= intervalMs) {
      // Noop scheduled consolidation when the buffer has too few entries to
      // justify an LLM run — mirrors the heartbeat max-consecutive-runs skip.
      // The checkpoint advances so the next check fires after the regular
      // interval. Manual "Run now" is unaffected (routes layer, not schedule).
      if (jobType === consolidateEntry.jobType) {
        if (memoryBufferLineCount() < MIN_BUFFER_LINES_FOR_CONSOLIDATION) {
          log.debug(
            "Scheduled consolidation skipped: buffer under minimum line threshold",
          );
          setMemoryCheckpoint(key, String(nowMs));
          continue;
        }
      }
      const payload =
        jobType === consolidateEntry.jobType
          ? AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD
          : {};
      enqueueMemoryJob(jobType, payload);
      setMemoryCheckpoint(key, String(nowMs));
      if (jobType === consolidateEntry.jobType) {
        enqueuedConsolidate = true;
      }
    }
  }

  // Size-based trigger: when the shared buffer crosses the configured line
  // count, drain it now rather than waiting out the interval. Retargets to the
  // same consolidator the interval branch above selected.
  //
  // The size branch is checkpoint-blind by design (it must fire before the
  // interval elapses), so it dedupes against an already-active consolidate job
  // instead — otherwise it would re-enqueue on every worker tick while the
  // buffer stays over threshold, flooding the queue with redundant LLM work.
  const maxLines = config.memory.v2.consolidation_max_buffer_lines;
  if (
    v2Active &&
    !enqueuedConsolidate &&
    maxLines !== null &&
    !hasActiveJobOfType(consolidateEntry.jobType)
  ) {
    if (memoryBufferLineCount() >= maxLines) {
      enqueueMemoryJob(
        consolidateEntry.jobType,
        AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD,
      );
      setMemoryCheckpoint(consolidateEntry.key, String(nowMs));
    }
  }

  // PKB filing/compaction — v1-only, like the v1 graph entries above (under
  // v2 the consolidation job owns periodic background memory processing).
  // Same durable-checkpoint pattern, with four PKB-specific gates:
  //  - no checkpoint yet (fresh workspace, or the first tick after an
  //    upgrade): seed it to now WITHOUT enqueuing, so the first run lands a
  //    full interval later instead of an LLM job firing at boot;
  //  - outside the configured active-hours window: skip AND advance the
  //    checkpoint, so the next attempt lands a full interval later (the
  //    interval cadence, not a busy-retry against a closed window);
  //  - filing with an empty buffer: skip and advance — no work, no LLM run
  //    (mirrors the consolidation minimum-line skip above);
  //  - either PKB job already pending/running: skip WITHOUT advancing, so the
  //    next worker tick retries. Filing and compaction both rewrite the PKB
  //    tree, so at most one of the two is ever in the queue.
  if (!v2Active) {
    const filingConfig = config.filing;
    const withinActiveHours = isWithinPkbActiveHours(
      new Date(nowMs).getHours(),
      filingConfig.activeHoursStart ?? null,
      filingConfig.activeHoursEnd ?? null,
    );
    const pkbSchedule: Array<{
      key: string;
      intervalMs: number;
      jobType: MemoryJobType;
      enabled: boolean;
      hasWork: () => boolean;
    }> = [
      {
        key: GRAPH_MAINTENANCE_CHECKPOINTS.pkbFiling,
        intervalMs: filingConfig.intervalMs,
        jobType: "pkb_filing",
        enabled: filingConfig.enabled,
        hasWork: () => hasPkbBufferContent(),
      },
      {
        key: GRAPH_MAINTENANCE_CHECKPOINTS.pkbCompaction,
        intervalMs: filingConfig.compactionIntervalMs,
        jobType: "pkb_compaction",
        enabled: filingConfig.compactionEnabled,
        hasWork: () => true,
      },
    ];
    for (const { key, intervalMs, jobType, enabled, hasWork } of pkbSchedule) {
      if (!enabled) {
        continue;
      }
      const checkpoint = getMemoryCheckpoint(key);
      if (checkpoint === null) {
        setMemoryCheckpoint(key, String(nowMs));
        continue;
      }
      const lastRun = parseInt(checkpoint, 10);
      if (nowMs - lastRun < intervalMs) {
        continue;
      }
      if (!withinActiveHours || !hasWork()) {
        setMemoryCheckpoint(key, String(nowMs));
        continue;
      }
      if (
        hasActiveJobOfType("pkb_filing") ||
        hasActiveJobOfType("pkb_compaction")
      ) {
        continue;
      }
      enqueueMemoryJob(jobType, {});
      setMemoryCheckpoint(key, String(nowMs));
    }
  }
}
