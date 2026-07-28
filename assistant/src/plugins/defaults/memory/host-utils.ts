/**
 * The memory plugin's single channel for generic host utilities. Every module
 * in this plugin obtains these helpers here rather than importing the host
 * `util/*` modules directly, so the host imports below are the plugin's sole
 * util escapes (tracked by `plugin-import-boundary-guard.test.ts`), mirroring
 * `logging.ts` and `paths.ts`.
 *
 * Forwarding (not copying) is deliberate: `BackendUnavailableError` identity
 * must be shared with the host — `persistence/job-utils` classifies plugin-
 * thrown errors via `instanceof` — and `isAbortReason` must agree with the
 * host's abort-reason tagging. The pure helpers forward alongside them so the
 * plugin has exactly one file to re-home per concern (own the copy, or a
 * contract facet) if memory ever builds as an external plugin.
 *
 * Namespace imports keep this module loadable under tests that mock a host
 * util with a subset of its exports; each wrapper resolves its function at
 * call time, so `mock.module` interception keeps working through the waist.
 */
import type { AbortReason } from "../../../util/abort-reasons.js";
import * as hostAbortReasons from "../../../util/abort-reasons.js";
import * as hostLogRedact from "../../../util/log-redact.js";
import * as hostProcessLiveness from "../../../util/process-liveness.js";
import * as hostRetry from "../../../util/retry.js";
import type { SqliteRetryOptions } from "../../../util/sqlite-retry.js";
import * as hostSqliteRetry from "../../../util/sqlite-retry.js";
import * as hostStripCommentLines from "../../../util/strip-comment-lines.js";
import * as hostTruncate from "../../../util/truncate.js";
import * as hostWorkerMemory from "../../../util/worker-memory.js";

export { BackendUnavailableError } from "../../../util/errors.js";
export { PromiseGuard } from "../../../util/promise-guard.js";

export function isAbortReason(value: unknown): value is AbortReason {
  return hostAbortReasons.isAbortReason(value);
}

export function redactLogString(value: string): string {
  return hostLogRedact.redactLogString(value);
}

export function isProcessAlive(pid: number): boolean {
  return hostProcessLiveness.isProcessAlive(pid);
}

export function computeRetryDelay(
  attempt: number,
  baseDelayMs?: number,
): number {
  return baseDelayMs === undefined
    ? hostRetry.computeRetryDelay(attempt)
    : hostRetry.computeRetryDelay(attempt, baseDelayMs);
}

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return hostRetry.abortableSleep(ms, signal);
}

export function withSqliteRetry<T>(
  fn: () => T | Promise<T>,
  options: SqliteRetryOptions,
): Promise<T> {
  return hostSqliteRetry.withSqliteRetry(fn, options);
}

export function stripCommentLines(content: string): string {
  return hostStripCommentLines.stripCommentLines(content);
}

export function truncate(str: string, maxLen: number, suffix?: string): string {
  return suffix === undefined
    ? hostTruncate.truncate(str, maxLen)
    : hostTruncate.truncate(str, maxLen, suffix);
}

export function workerMemoryEnv(): Record<string, string | undefined> {
  return hostWorkerMemory.workerMemoryEnv();
}
