import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { getLogger } from "../util/logger.js";
import { rawAll, rawRun } from "./db.js";
import { backfillJob } from "./job-handlers/backfill.js";
import { batchExtractJob } from "./job-handlers/batch-extraction.js";
import {
  cleanupStaleSupersededItemsJob,
  pruneOldConversationsJob,
} from "./job-handlers/cleanup.js";
import { generateConversationStartersJob } from "./job-handlers/conversation-starters.js";
// ── Per-job-type handlers ──────────────────────────────────────────
import {
  embedAttachmentJob,
  embedItemJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./job-handlers/embedding.js";
import { extractItemsJob } from "./job-handlers/extraction.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
} from "./job-handlers/index-maintenance.js";
import { journalCarryForwardJob } from "./job-handlers/journal-carry-forward.js";
import { mediaProcessingJob } from "./job-handlers/media-processing.js";
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
  enqueueCleanupStaleSupersededItemsJob,
  enqueueMemoryJob,
  enqueuePruneOldConversationsJob,
  failMemoryJob,
  failStalledJobs,
  type MemoryJob,
  resetRunningJobsToPending,
} from "./jobs-store.js";
import { QdrantCircuitOpenError } from "./qdrant-circuit-breaker.js";

const log = getLogger("memory-jobs-worker");

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

  // Startup recovery: enqueue batch_extract for conversations with pending
  // unextracted messages (e.g. after a crash mid-conversation).
  try {
    const pendingRows = rawAll<{ key: string; value: string }>(
      `SELECT key, value FROM memory_checkpoints WHERE key LIKE 'batch_extract:%:pending_count' AND CAST(value AS INTEGER) > 0`,
    );
    for (const row of pendingRows) {
      // Extract conversationId from key: "batch_extract:<conversationId>:pending_count"
      const parts = row.key.split(":");
      if (parts.length >= 3) {
        const conversationId = parts.slice(1, -1).join(":");
        enqueueMemoryJob("batch_extract", { conversationId });
        log.info(
          { conversationId, pendingCount: row.value },
          "Recovered pending batch extraction on startup",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to recover pending batch extractions on startup",
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

  // Periodic stale item sweep (throttled to at most once per hour)
  sweepStaleItems(config);

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
    return 0;
  }

  // Group jobs by type so same-type jobs run sequentially (preventing
  // checkpoint races for backfill, etc.), while different types run concurrently.
  const jobsByType = new Map<string, MemoryJob[]>();
  for (const job of jobs) {
    let group = jobsByType.get(job.type);
    if (!group) {
      group = [];
      jobsByType.set(job.type, group);
    }
    group.push(job);
  }

  let processed = 0;
  const typeGroups = [...jobsByType.values()];

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
  return processed;
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
    case "embed_item":
      await embedItemJob(job, config);
      return;
    case "embed_summary":
      await embedSummaryJob(job, config);
      return;
    case "extract_items":
      await extractItemsJob(job);
      return;
    case "batch_extract":
      await batchExtractJob(job);
      return;
    case "extract_entities":
      // Entity extraction has been removed — silently drop legacy jobs
      return;
    case "cleanup_stale_superseded_items":
      cleanupStaleSupersededItemsJob(job, config);
      return;
    case "prune_old_conversations":
      pruneOldConversationsJob(job, config);
      return;
    case "build_conversation_summary":
      // Deprecated: conversation summaries are now produced as a side-effect
      // of batch extraction. Silently skip legacy jobs.
      log.debug(
        { jobId: job.id },
        "Skipping deprecated build_conversation_summary job — handled by batch extraction",
      );
      return;
    case "backfill":
      await backfillJob(job, config);
      return;
    case "backfill_entity_relations":
      // Entity relation backfill has been removed — silently drop legacy jobs
      return;
    case "refresh_weekly_summary":
    case "refresh_monthly_summary":
      // Global summary rollups have been removed — silently drop legacy jobs
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
    case "journal_carry_forward":
      await journalCarryForwardJob(job);
      return;
    case "generate_conversation_starters":
      await generateConversationStartersJob(job);
      return;
    case "generate_capability_cards":
      // Capability cards were removed — silently drop legacy jobs.
      return;
    case "generate_thread_starters":
      // Thread starters renamed to conversation starters — silently drop legacy jobs
      return;
    default:
      throw new Error(
        `Unknown memory job type: ${(job as { type: string }).type}`,
      );
  }
}

// ── Cleanup scheduling ─────────────────────────────────────────────

let lastScheduledCleanupEnqueueMs = 0;

/** Reset the cleanup enqueue throttle so tests can run deterministic checks. */
export function resetCleanupScheduleThrottle(): void {
  lastScheduledCleanupEnqueueMs = 0;
}

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
  if (nowMs - lastScheduledCleanupEnqueueMs < cleanup.enqueueIntervalMs)
    return false;

  const staleSupersededItemsJobId = enqueueCleanupStaleSupersededItemsJob(
    cleanup.supersededItemRetentionMs,
  );
  const pruneConversationsJobId =
    cleanup.conversationRetentionDays > 0
      ? enqueuePruneOldConversationsJob(cleanup.conversationRetentionDays)
      : null;
  lastScheduledCleanupEnqueueMs = nowMs;
  log.debug(
    {
      staleSupersededItemsJobId,
      pruneConversationsJobId,
      enqueueIntervalMs: cleanup.enqueueIntervalMs,
      supersededItemRetentionMs: cleanup.supersededItemRetentionMs,
      conversationRetentionDays: cleanup.conversationRetentionDays,
    },
    "Enqueued scheduled memory cleanup jobs",
  );
  return true;
}

// ── Stale item sweep ───────────────────────────────────────────────

const STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let lastStaleSweepMs = 0;

/** Reset the sweep throttle so tests can call sweepStaleItems back-to-back. */
export function resetStaleSweepThrottle(): void {
  lastStaleSweepMs = 0;
}

/**
 * Mark deeply stale memory items as invalid. An item is considered deeply
 * stale when it has exceeded 2x its freshness window for its kind and has
 * not been recently accessed.
 *
 * This is non-destructive: items keep their data but get an `invalid_at`
 * timestamp that excludes them from retrieval queries.
 */
export function sweepStaleItems(config: AssistantConfig): number {
  const freshness = config.memory.retrieval.freshness;
  if (!freshness.enabled) return 0;

  const now = Date.now();
  // Throttle: at most once per hour
  if (now - lastStaleSweepMs < STALE_SWEEP_INTERVAL_MS) return 0;
  lastStaleSweepMs = now;

  let totalMarked = 0;
  for (const [kind, maxAgeDays] of Object.entries(freshness.maxAgeDays)) {
    if (maxAgeDays <= 0) continue;
    // Mark invalid if: past 2x window, no access in the shield period, and not already invalid
    const cutoffMs = now - maxAgeDays * 2 * 86_400_000;
    const shieldCutoffMs = now - freshness.reinforcementShieldDays * 86_400_000;
    const changes = rawRun(
      `
      UPDATE memory_items
      SET invalid_at = ?
      WHERE kind = ?
        AND status = 'active'
        AND invalid_at IS NULL
        AND last_seen_at < ?
        AND (access_count = 0 OR COALESCE(last_used_at, 0) < ?)
    `,
      now,
      kind,
      cutoffMs,
      shieldCutoffMs,
    );
    if (changes > 0) {
      log.info(
        { kind, marked: changes, cutoffMs },
        "Marked stale memory items as invalid",
      );
      totalMarked += changes;
    }
  }
  return totalMarked;
}
