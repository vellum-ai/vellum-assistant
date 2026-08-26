import type { Logger } from "pino";

import { computeRetryDelay } from "./retry-backoff.js";

export interface RetryPolicyJob {
  id: string;
  name: string;
  retryCount: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export type RetryDecision =
  | { action: "retry"; delayMs: number; nextRetryAt: number }
  | { action: "exhaust" };

/**
 * Pure decision function: given a job's retry state, decide whether
 * to retry with backoff or give up.
 *
 * `retryCount` is the PRE-increment value (before completeScheduleRun
 * bumped it). So `retryCount < maxRetries` allows exactly maxRetries
 * retries: retryCount 0, 1, …, maxRetries−1 all pass the check.
 */
export function decideRetry(
  job: RetryPolicyJob,
  now: number = Date.now(),
): RetryDecision {
  if (job.retryCount < job.maxRetries) {
    const delayMs = computeRetryDelay(job.retryCount, job.retryBackoffMs);
    return { action: "retry", delayMs, nextRetryAt: now + delayMs };
  }
  return { action: "exhaust" };
}

/**
 * Apply the retry decision to a schedule: schedule a retry or exhaust.
 * Calls the provided store operations so this module stays decoupled
 * from direct DB imports.
 */
export async function applyRetryDecision(params: {
  job: RetryPolicyJob;
  isOneShot: boolean;
  decision: RetryDecision;
  scheduleRetry: (id: string, nextRetryAt: number) => void | Promise<void>;
  failOneShotPermanently: (id: string) => void | Promise<void>;
  resetRetryCount: (id: string) => void | Promise<void>;
  /**
   * Fired exactly once, when retries are exhausted. This is the single
   * user-facing alert for a failed schedule (per-attempt failures are
   * retried silently), and the caller owns its content and dedupe key.
   */
  emitAlert: () => void;
  log: Logger;
}): Promise<void> {
  const { job, isOneShot, decision } = params;

  if (decision.action === "retry") {
    await params.scheduleRetry(job.id, decision.nextRetryAt);
    params.log.info(
      {
        jobId: job.id,
        name: job.name,
        attempt: job.retryCount + 1,
        maxRetries: job.maxRetries,
        delayMs: decision.delayMs,
      },
      "Scheduling retry with backoff",
    );
  } else {
    if (isOneShot) {
      await params.failOneShotPermanently(job.id);
    } else {
      await params.resetRetryCount(job.id);
    }
    params.emitAlert();
    params.log.warn(
      { jobId: job.id, name: job.name, attempts: job.retryCount + 1 },
      "Schedule retries exhausted",
    );
  }
}
