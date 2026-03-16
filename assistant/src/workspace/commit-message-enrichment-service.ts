/**
 * Non-blocking enrichment queue for post-commit message enhancement.
 *
 * After a synchronous commit succeeds, callers can enqueue enrichment jobs
 * that run asynchronously without blocking the commit path. This is the
 * scaffold for future LLM-powered commit message enrichment.
 *
 * Key properties:
 * - Bounded queue with configurable max size (drops oldest on overflow)
 * - Bounded concurrency (default 1 worker)
 * - Per-job timeout with retry + exponential backoff
 * - Graceful shutdown: drains in-flight jobs, discards pending jobs
 * - Fire-and-forget: enqueue() never blocks or throws
 */

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import type { CommitContext } from "./commit-message-provider.js";
import type { WorkspaceGitService } from "./git-service.js";

const log = getLogger("enrichment-queue");

export interface EnrichmentJob {
  workspaceDir: string;
  commitHash: string;
  context: CommitContext;
  gitService: WorkspaceGitService;
}

interface InternalJob extends EnrichmentJob {
  attempts: number;
}

export interface EnrichmentServiceOptions {
  maxQueueSize?: number;
  maxConcurrency?: number;
  jobTimeoutMs?: number;
  maxRetries?: number;
}

/**
 * Non-blocking enrichment queue service.
 *
 * Enqueue jobs after successful commits. Each job runs the enrichment
 * worker (currently a no-op placeholder) and writes the result as a
 * git note on the commit.
 */
export class CommitEnrichmentService {
  private readonly maxQueueSize: number;
  private readonly maxConcurrency: number;
  private readonly jobTimeoutMs: number;
  private readonly maxRetries: number;

  private queue: InternalJob[] = [];
  private activeWorkers = 0;
  private droppedCount = 0;
  private succeededCount = 0;
  private failedCount = 0;
  private shuttingDown = false;
  private inFlightPromises: Set<Promise<void>> = new Set();

  constructor(options?: EnrichmentServiceOptions) {
    const config = getConfig();
    const gitConfig = config.workspaceGit;
    this.maxQueueSize =
      options?.maxQueueSize ?? gitConfig?.enrichmentQueueSize ?? 50;
    this.maxConcurrency =
      options?.maxConcurrency ?? gitConfig?.enrichmentConcurrency ?? 1;
    this.jobTimeoutMs =
      options?.jobTimeoutMs ?? gitConfig?.enrichmentJobTimeoutMs ?? 30000;
    this.maxRetries =
      options?.maxRetries ?? gitConfig?.enrichmentMaxRetries ?? 2;
  }

  /**
   * Enqueue an enrichment job. Fire-and-forget — never blocks or throws.
   */
  enqueue(job: EnrichmentJob): void {
    if (this.shuttingDown) {
      log.debug(
        { commitHash: job.commitHash },
        "Enrichment queue shutting down, discarding job",
      );
      return;
    }

    const internalJob: InternalJob = { ...job, attempts: 0 };

    // Drop oldest if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift()!;
      this.droppedCount++;
      log.warn(
        {
          droppedHash: dropped.commitHash,
          queueSize: this.queue.length,
          droppedCount: this.droppedCount,
        },
        "Enrichment queue full, dropping oldest job",
      );
    }

    this.queue.push(internalJob);
    log.debug(
      { commitHash: job.commitHash, queueSize: this.queue.length },
      "Enrichment job enqueued",
    );

    this.processNext();
  }

  /**
   * Graceful shutdown: discard pending queue and wait for in-flight jobs only.
   *
   * Bounded shutdown time is more important than processing all pending
   * enrichments. Enrichment is best-effort metadata and must never delay
   * daemon shutdown materially. Pending jobs are counted as dropped.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Discard pending jobs — enrichment is best-effort and must not delay shutdown
    if (this.queue.length > 0) {
      const pendingCount = this.queue.length;
      this.droppedCount += pendingCount;
      this.queue = [];
      log.info(
        { discarded: pendingCount, droppedCount: this.droppedCount },
        "Enrichment queue shutting down, discarded pending jobs",
      );
    }

    // Wait for any in-flight workers to finish
    if (this.inFlightPromises.size > 0) {
      log.debug(
        { inFlight: this.inFlightPromises.size },
        "Waiting for in-flight enrichment jobs",
      );
      await Promise.all(this.inFlightPromises);
    }

    log.info(
      {
        succeeded: this.succeededCount,
        failed: this.failedCount,
        dropped: this.droppedCount,
      },
      "Enrichment queue shut down",
    );
  }

  /** @internal Test-only: get queue size */
  _getQueueSize(): number {
    return this.queue.length;
  }

  /** @internal Test-only: get dropped count */
  _getDroppedCount(): number {
    return this.droppedCount;
  }

  /** @internal Test-only: get succeeded count */
  _getSucceededCount(): number {
    return this.succeededCount;
  }

  /** @internal Test-only: get failed count */
  _getFailedCount(): number {
    return this.failedCount;
  }

  /** @internal Test-only: get active workers */
  _getActiveWorkers(): number {
    return this.activeWorkers;
  }

  private processNext(): void {
    if (this.shuttingDown) return;
    if (this.activeWorkers >= this.maxConcurrency) return;
    if (this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.activeWorkers++;

    const promise = this.executeJob(job).finally(() => {
      this.activeWorkers--;
      this.inFlightPromises.delete(promise);
      // Try to process next job after this one completes
      this.processNext();
    });

    this.inFlightPromises.add(promise);
  }

  private async executeJob(job: InternalJob): Promise<void> {
    job.attempts++;

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the enrichment work against a timeout.
      // When the timeout wins, controller.abort() kills in-progress work,
      // causing doEnrichment to reject with an AbortError. Since Promise.race
      // has already settled with the timeout error, that rejection is orphaned.
      // The .catch() swallows it to prevent an unhandled promise rejection.
      const enrichmentPromise = this.doEnrichment(job, controller.signal);
      enrichmentPromise.catch(() => {
        // Intentionally swallowed — the timeout branch already handled the error
      });
      await Promise.race([
        enrichmentPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error("Enrichment job timed out"));
          }, this.jobTimeoutMs);
        }),
      ]);
      this.succeededCount++;
      log.debug(
        { commitHash: job.commitHash, attempts: job.attempts },
        "Enrichment job completed",
      );
    } catch (err) {
      controller.abort();
      const isTimeout =
        err instanceof Error && err.message === "Enrichment job timed out";
      if (job.attempts <= this.maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, ...
        const backoffMs = 1000 * Math.pow(2, job.attempts - 1);
        log.debug(
          {
            commitHash: job.commitHash,
            attempts: job.attempts,
            backoffMs,
            timedOut: isTimeout,
            err,
          },
          isTimeout
            ? "Enrichment job timed out, scheduling retry"
            : "Enrichment job failed, scheduling retry",
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

        if (!this.shuttingDown) {
          // Re-enqueue at front for retry (don't count against queue limit)
          this.queue.unshift(job);
          this.processNext();
        } else {
          // Can't retry during shutdown — count as failed
          this.failedCount++;
        }
        return;
      }

      this.failedCount++;
      log.warn(
        {
          commitHash: job.commitHash,
          attempts: job.attempts,
          timedOut: isTimeout,
          err,
        },
        isTimeout
          ? "Enrichment job timed out after max retries"
          : "Enrichment job failed after max retries",
      );
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Perform the actual enrichment work.
   *
   * Currently a no-op placeholder that writes a scaffold JSON note
   * to prove the plumbing works. Future: call LLM to generate a
   * rich commit description and write it as a git note.
   *
   * Accepts an AbortSignal so callers (e.g. timeout) can cancel
   * in-progress work and prevent zombie enrichment jobs.
   */
  private async doEnrichment(
    job: InternalJob,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;

    const note = JSON.stringify({
      enriched: true,
      trigger: job.context.trigger,
      filesChanged: job.context.changedFiles.length,
      timestamp: job.context.timestampMs,
      conversationId: job.context.conversationId,
      turnNumber: job.context.turnNumber,
    });

    if (signal?.aborted) return;
    await job.gitService.writeNote(job.commitHash, note, signal);
  }
}

/** Singleton enrichment service instance. */
let enrichmentService: CommitEnrichmentService | null = null;

/**
 * Get the global enrichment service singleton.
 * Created lazily on first access.
 */
export function getEnrichmentService(): CommitEnrichmentService {
  if (!enrichmentService) {
    enrichmentService = new CommitEnrichmentService();
  }
  return enrichmentService;
}

/**
 * @internal Test-only: reset the singleton
 */
export function _resetEnrichmentService(): void {
  enrichmentService = null;
}
