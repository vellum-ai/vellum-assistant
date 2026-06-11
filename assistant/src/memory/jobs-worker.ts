import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { maintainJob as memoryV3MaintainJob } from "../plugins/defaults/memory-v3-shadow/maintain-job.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import {
  getLastScheduledCleanupEnqueueMs,
  markScheduledCleanupEnqueued,
} from "./cleanup-schedule-state.js";
import { conversationAnalyzeJob } from "./conversation-analyze-job.js";
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
  pruneOldTraceEventsJob,
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
import { embedConceptPageJob } from "./jobs/embed-concept-page.js";
import { embedPkbFileJob } from "./jobs/embed-pkb-file.js";
import {
  claimMemoryJobs,
  completeMemoryJob,
  deferMemoryJob,
  EMBED_JOB_TYPES,
  enqueueMemoryJob,
  enqueuePruneOldConversationsJob,
  enqueuePruneOldLlmRequestLogsJob,
  enqueuePruneOldTraceEventsJob,
  failMemoryJob,
  failStalledJobs,
  hasActiveJobOfType,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS,
  type MemoryJob,
  type MemoryJobType,
  resetRunningJobsToPending,
  SLOW_LLM_JOB_TYPES,
} from "./jobs-store.js";
import { memoryRetrospectiveJob } from "./memory-retrospective-job.js";
import { sweepOrphanMemoryRetrospectiveConversations } from "./memory-retrospective-startup-cleanup.js";
import { QdrantCircuitOpenError } from "./qdrant-circuit-breaker.js";
import {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
  memoryV2ReembedJob,
} from "./v2/backfill-jobs.js";
import {
  countBufferLines,
  memoryV2ConsolidateJob,
} from "./v2/consolidation-job.js";
import { memoryV2SweepJob } from "./v2/sweep-job.js";

const log = getLogger("memory-jobs-worker");

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

  // After running-job recovery (so legitimate in-flight retries aren't
  // swept), clean up orphan memory-retrospective background conversations
  // left behind by daemon crashes mid-job. Best-effort — never block worker
  // startup on cleanup failures.
  try {
    sweepOrphanMemoryRetrospectiveConversations();
  } catch (err) {
    log.warn(
      { err },
      "Memory-retrospective startup cleanup failed; continuing worker startup",
    );
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

type ProcessGroup = (group: MemoryJob[]) => Promise<number>;

export async function runMemoryJobsOnce(
  options: { enableScheduledCleanup?: boolean } = {},
): Promise<number> {
  const config = getConfig();
  if (config.memory.enabled === false) return 0;
  const enableScheduledCleanup = options.enableScheduledCleanup === true;

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
  // embed lane inside `claimMemoryJobs`.
  const claimed = claimMemoryJobs({
    slowLlm: cfgSlow,
    fast: cfgFast,
    embed: cfgEmbed,
  });

  if (claimed.length === 0) {
    if (enableScheduledCleanup) {
      maybeEnqueueScheduledCleanupJobs(config);
    }
    maybeEnqueueGraphMaintenanceJobs(config);
    await maybeRunDbMaintenance();
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
  if (jobs.length === 0) return 0;

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
  if (config.memory.v2.enabled && V1_QDRANT_JOB_TYPES.has(job.type)) {
    return;
  }
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
      await pruneOldLlmRequestLogsJob(job, config);
      return;
    case "prune_old_trace_events":
      await pruneOldTraceEventsJob(job, config);
      return;
    case "build_conversation_summary":
      // Stale rows enqueued before v2 was enabled must not consume the
      // `conversationSummarization` LLM budget — v2 readers do not consume
      // `memorySummaries`, mirroring the `graph_extract` gate below.
      if (config.memory.v2.enabled) {
        return;
      }
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
    case "embed_pkb_file":
      await embedPkbFileJob(job, config);
      return;
    case "graph_trigger_embed":
      await embedGraphTriggerJob(job, config);
      return;
    case "graph_extract":
      // Stale rows enqueued before v2 was enabled (or by any unguarded v1
      // path) must not consume embedding/extraction budget when v2 is on.
      if (config.memory.v2.enabled) {
        return;
      }
      await graphExtractJob(job, config);
      return;
    case "conversation_analyze":
      await conversationAnalyzeJob(job, config);
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
    case "embed_concept_page":
      await embedConceptPageJob(job, config);
      return;
    case "memory_v2_sweep":
      await memoryV2SweepJob(job, config);
      return;
    case "memory_v2_consolidate":
      await memoryV2ConsolidateJob(job, config);
      return;
    case "memory_v2_migrate":
      await memoryV2MigrateJob(job, config);
      return;
    case "memory_v2_reembed":
      await memoryV2ReembedJob(job, config);
      return;
    case "memory_v2_activation_recompute":
      await memoryV2ActivationRecomputeJob(job, config);
      return;
    case "memory_v3_maintain":
      await memoryV3MaintainJob(job, config);
      return;
    case "memory_retrospective":
      await memoryRetrospectiveJob(job, config);
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

/**
 * Enqueue periodic cleanup jobs using config-driven retention windows.
 * Enqueue is deduped in jobs-store, so repeated calls remain safe.
 */
function maybeEnqueueScheduledCleanupJobs(
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
  const pruneTraceEventsJobId =
    cleanup.traceEventRetentionDays > 0
      ? enqueuePruneOldTraceEventsJob(cleanup.traceEventRetentionDays)
      : null;
  markScheduledCleanupEnqueued(nowMs);
  log.debug(
    {
      pruneConversationsJobId,
      pruneLlmRequestLogsJobId,
      pruneTraceEventsJobId,
      enqueueIntervalMs: cleanup.enqueueIntervalMs,
      conversationRetentionDays: cleanup.conversationRetentionDays,
      llmRequestLogRetentionMs: cleanup.llmRequestLogRetentionMs,
      traceEventRetentionDays: cleanup.traceEventRetentionDays,
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
export function maybeEnqueueGraphMaintenanceJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): void {
  const memoryEnabled = config.memory.enabled !== false;
  if (!memoryEnabled) return;

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
  // runs under either branch. Gated on the same flags that gate the v3 plugin
  // so it stays inert when v3 is off. The post-consolidation follow-up in
  // `consolidation-job.ts` remains the primary trigger; this interval only
  // self-heals when that follow-up is missed (failed enqueue). The job handler
  // itself no-ops when v3 is off, so
  // this guard is belt-and-suspenders that also avoids a wasted enqueue.
  if (
    isAssistantFeatureFlagEnabled("memory-v3-shadow", config) ||
    isAssistantFeatureFlagEnabled("memory-v3-live", config)
  ) {
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
        const bufferPath = join(getWorkspaceDir(), "memory", "buffer.md");
        if (countBufferLines(bufferPath) < MIN_BUFFER_LINES_FOR_CONSOLIDATION) {
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
      if (jobType === consolidateEntry.jobType) enqueuedConsolidate = true;
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
    const bufferPath = join(getWorkspaceDir(), "memory", "buffer.md");
    if (countBufferLines(bufferPath) >= maxLines) {
      enqueueMemoryJob(
        consolidateEntry.jobType,
        AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD,
      );
      setMemoryCheckpoint(consolidateEntry.key, String(nowMs));
    }
  }
}
