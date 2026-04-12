import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { getLogger } from "../util/logger.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import {
  getLastScheduledCleanupEnqueueMs,
  markScheduledCleanupEnqueued,
  resetCleanupScheduleThrottle as resetCleanupScheduleThrottleImpl,
} from "./cleanup-schedule-state.js";
import { maybeRunDbMaintenance } from "./db-maintenance.js";
import { bootstrapFromHistory } from "./graph/bootstrap.js";
import { runConsolidation } from "./graph/consolidation.js";
import { runDecayTick } from "./graph/decay.js";
import { graphExtractJob } from "./graph/extraction-job.js";
import {
  embedGraphNodeJob,
  embedGraphTriggerJob,
} from "./graph/graph-search.js";
import { runNarrativeRefinement } from "./graph/narrative.js";
import { runPatternScan } from "./graph/pattern-scan.js";
import { backfillJob } from "./job-handlers/backfill.js";
import {
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
} from "./job-handlers/cleanup.js";
import { generateConversationStartersJob } from "./job-handlers/conversation-starters.js";
// ── Per-job-type handlers ──────────────────────────────────────────
import {
  embedAttachmentJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./job-handlers/embedding.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
} from "./job-handlers/index-maintenance.js";
import { mediaProcessingJob } from "./job-handlers/media-processing.js";
import { buildConversationSummaryJob } from "./job-handlers/summarization.js";
import {
  BackendUnavailableError,
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "./job-utils.js";
import {
  claimMemoryJobs,
  completeMemoryJob,
  deferMemoryJob,
  enqueueMemoryJob,
  enqueuePruneOldConversationsJob,
  enqueuePruneOldLlmRequestLogsJob,
  failMemoryJob,
  failStalledJobs,
  type MemoryJob,
  type MemoryJobType,
  resetRunningJobsToPending,
} from "./jobs-store.js";
import { QdrantCircuitOpenError } from "./qdrant-circuit-breaker.js";

const log = getLogger("memory-jobs-worker");

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
]);

export const POLL_INTERVAL_MIN_MS = 1_500;
export const POLL_INTERVAL_MAX_MS = 30_000;

export interface MemoryJobsWorker {
  runOnce(): Promise<number>;
  stop(): void;
}

export function startMemoryJobsWorker(): MemoryJobsWorker {
  const recovered = resetRunningJobsToPending();
  if (recovered > 0) {
    log.info({ recovered }, "Recovered stale running memory jobs");
  }

  let stopped = false;
  let tickRunning = false;
  let timer: ReturnType<typeof setTimeout>;
  let currentIntervalMs = POLL_INTERVAL_MIN_MS;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      const processed = await runMemoryJobsOnce({
        enableScheduledCleanup: true,
      });
      if (processed > 0) {
        currentIntervalMs = POLL_INTERVAL_MIN_MS;
      } else {
        currentIntervalMs = Math.min(
          currentIntervalMs * 2,
          POLL_INTERVAL_MAX_MS,
        );
      }
    } catch (err) {
      log.error({ err }, "Memory worker tick failed");
      currentIntervalMs = Math.min(currentIntervalMs * 2, POLL_INTERVAL_MAX_MS);
    } finally {
      tickRunning = false;
    }
  };

  const scheduleTick = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().then(() => {
        if (!stopped) scheduleTick();
      });
    }, currentIntervalMs);
    (timer as NodeJS.Timeout).unref?.();
  };

  void tick().then(() => {
    if (!stopped) scheduleTick();
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

export async function runMemoryJobsOnce(
  options: { enableScheduledCleanup?: boolean } = {},
): Promise<number> {
  const config = getConfig();
  if (!config.memory.enabled) return 0;
  const enableScheduledCleanup = options.enableScheduledCleanup === true;

  // Fail jobs that have been running longer than the configured timeout
  const timedOut = failStalledJobs(config.memory.jobs.stalledJobTimeoutMs);
  if (timedOut > 0) {
    log.warn({ timedOut }, "Timed out stalled memory jobs");
  }

  const batchSize = Math.max(1, config.memory.jobs.batchSize);
  const concurrency = Math.max(1, config.memory.jobs.workerConcurrency);
  const jobs = claimMemoryJobs(batchSize);
  if (jobs.length === 0) {
    if (enableScheduledCleanup) {
      maybeEnqueueScheduledCleanupJobs(config);
    }
    maybeEnqueueGraphMaintenanceJobs();
    maybeRunDbMaintenance();
    return 0;
  }

  // Group jobs so they can run concurrently across independent work units.
  // Jobs targeting different conversations (via payload.conversationId) are
  // placed in separate groups and can run in parallel. Jobs targeting the
  // same conversation, or global jobs without a conversationId (backfill,
  // cleanup, rebuild_index), are grouped together and run sequentially to
  // prevent checkpoint races.
  const jobGroups = new Map<string, MemoryJob[]>();
  for (const job of jobs) {
    const convId =
      typeof job.payload.conversationId === "string"
        ? job.payload.conversationId
        : null;
    const groupKey = convId ? `${job.type}:${convId}` : job.type;
    let group = jobGroups.get(groupKey);
    if (!group) {
      group = [];
      jobGroups.set(groupKey, group);
    }
    group.push(job);
  }

  let processed = 0;
  const typeGroups = [...jobGroups.values()];

  // Run type groups concurrently using a task pool (up to workerConcurrency
  // active at a time). Unlike the old wave approach, a new group starts as
  // soon as any slot frees up — no waiting for an entire wave to finish.
  const processGroup = async (group: MemoryJob[]): Promise<number> => {
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
      }
    }
    return groupProcessed;
  };

  if (typeGroups.length <= concurrency) {
    // Fast path: all groups fit within the concurrency limit
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
  } else {
    // Task pool: maintain `concurrency` in-flight groups at all times
    let nextIdx = 0;

    const startNext = (): Promise<void> | undefined => {
      if (nextIdx >= typeGroups.length) return undefined;
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
  }
  if (enableScheduledCleanup) {
    maybeEnqueueScheduledCleanupJobs(config);
  }
  maybeEnqueueGraphMaintenanceJobs();
  maybeRunDbMaintenance();
  return processed;
}

// ── Graph lifecycle job handlers ──────────────────────────────────

function graphDecayJob(job: MemoryJob): void {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = runDecayTick(scopeId);
  log.info({ jobId: job.id, ...result }, "Graph decay tick complete");
}

async function graphConsolidateJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runConsolidation(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.totalUpdated,
      deleted: result.totalDeleted,
      mergeEdges: result.totalMergeEdges,
    },
    "Graph consolidation complete",
  );
}

async function graphPatternScanJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runPatternScan(scopeId, config);
  log.info(
    {
      jobId: job.id,
      patterns: result.patternsDetected,
      edges: result.edgesCreated,
    },
    "Graph pattern scan complete",
  );
}

async function graphNarrativeRefineJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runNarrativeRefinement(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.nodesUpdated,
      arcs: result.arcsIdentified,
    },
    "Graph narrative refinement complete",
  );
}

// ── Job error handling ─────────────────────────────────────────────

function handleJobError(job: MemoryJob, err: unknown): void {
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
  switch (job.type) {
    case "embed_segment":
      await embedSegmentJob(job, config);
      return;
    case "embed_summary":
      await embedSummaryJob(job, config);
      return;
    case "prune_old_conversations":
      pruneOldConversationsJob(job, config);
      return;
    case "prune_old_llm_request_logs":
      pruneOldLlmRequestLogsJob(job, config);
      return;
    case "build_conversation_summary":
      await buildConversationSummaryJob(job, config);
      return;
    case "backfill":
      await backfillJob(job, config);
      return;
    case "rebuild_index":
      await rebuildIndexJob();
      return;
    case "delete_qdrant_vectors":
      await deleteQdrantVectorsJob(job);
      return;
    case "media_processing":
      await mediaProcessingJob(job);
      return;
    case "embed_media":
      await embedMediaJob(job, config);
      return;
    case "embed_attachment":
      await embedAttachmentJob(job, config);
      return;
    case "embed_graph_node":
      await embedGraphNodeJob(job, config);
      return;
    case "graph_trigger_embed":
      await embedGraphTriggerJob(job, config);
      return;
    case "graph_extract":
      await graphExtractJob(job, config);
      return;
    case "graph_decay":
      graphDecayJob(job);
      return;
    case "graph_consolidate":
      await graphConsolidateJob(job, config);
      return;
    case "graph_pattern_scan":
      await graphPatternScanJob(job, config);
      return;
    case "graph_narrative_refine":
      await graphNarrativeRefineJob(job, config);
      return;
    case "generate_conversation_starters":
      await generateConversationStartersJob(job);
      return;
    case "graph_bootstrap":
      await bootstrapFromHistory();
      return;

    default: {
      const rawType = (job as { type: string }).type;
      if (LEGACY_JOB_TYPES.has(rawType)) {
        log.debug({ jobId: job.id, type: rawType }, "Dropping legacy job");
        return;
      }
      throw new Error(`Unknown memory job type: ${rawType}`);
    }
  }
}

// ── Cleanup scheduling ─────────────────────────────────────────────

/**
 * Re-export of the shared throttle-reset helper. The underlying state lives
 * in cleanup-schedule-state.ts so that lighter-weight callers (e.g.
 * ConfigWatcher) can reset it without pulling in jobs-worker's transitive
 * imports.
 */
export const resetCleanupScheduleThrottle = resetCleanupScheduleThrottleImpl;

/**
 * Enqueue periodic cleanup jobs using config-driven retention windows.
 * Enqueue is deduped in jobs-store, so repeated calls remain safe.
 */
export function maybeEnqueueScheduledCleanupJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): boolean {
  const cleanup = config.memory.cleanup;
  if (!cleanup.enabled) return false;
  if (nowMs - getLastScheduledCleanupEnqueueMs() < cleanup.enqueueIntervalMs)
    return false;

  const pruneConversationsJobId =
    cleanup.conversationRetentionDays > 0
      ? enqueuePruneOldConversationsJob(cleanup.conversationRetentionDays)
      : null;
  const pruneLlmRequestLogsJobId =
    cleanup.llmRequestLogRetentionMs !== null
      ? enqueuePruneOldLlmRequestLogsJob(cleanup.llmRequestLogRetentionMs)
      : null;
  markScheduledCleanupEnqueued(nowMs);
  log.debug(
    {
      pruneConversationsJobId,
      pruneLlmRequestLogsJobId,
      enqueueIntervalMs: cleanup.enqueueIntervalMs,
      conversationRetentionDays: cleanup.conversationRetentionDays,
      llmRequestLogRetentionMs: cleanup.llmRequestLogRetentionMs,
    },
    "Enqueued scheduled memory cleanup jobs",
  );
  return true;
}

// ── Graph maintenance scheduling ──────────────────────────────────

const GRAPH_DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const GRAPH_CONSOLIDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const GRAPH_PATTERN_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GRAPH_NARRATIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const GRAPH_MAINTENANCE_CHECKPOINTS = {
  decay: "graph_maintenance:decay:last_run",
  consolidate: "graph_maintenance:consolidate:last_run",
  patternScan: "graph_maintenance:pattern_scan:last_run",
  narrative: "graph_maintenance:narrative:last_run",
} as const;

/**
 * Enqueue periodic graph maintenance jobs (decay, consolidation, pattern scan, narrative).
 * Uses durable checkpoints so intervals survive daemon restarts — jobs only fire
 * when the actual elapsed time since last run exceeds the interval.
 */
function maybeEnqueueGraphMaintenanceJobs(nowMs = Date.now()): void {
  const schedule: Array<{
    key: string;
    intervalMs: number;
    jobType: MemoryJobType;
  }> = [
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

  for (const { key, intervalMs, jobType } of schedule) {
    const lastRun = parseInt(getMemoryCheckpoint(key) ?? "0", 10);
    if (nowMs - lastRun >= intervalMs) {
      enqueueMemoryJob(jobType, {});
      setMemoryCheckpoint(key, String(nowMs));
    }
  }
}
