import type { UnifiedJobStatus } from "./platform-client.js";

/**
 * Terminal status returned by {@link pollJobUntilDone}. Callers decide
 * whether to treat `failed` as a fatal error or retry logic concern.
 */
export type TerminalJobStatus = Extract<
  UnifiedJobStatus,
  { status: "complete" | "failed" }
>;

export interface PollJobUntilDoneOptions {
  /** Async producer that returns the latest job status. */
  poll: () => Promise<UnifiedJobStatus>;
  /** Sleep between successive polls. Defaults to 2_000 ms. */
  intervalMs?: number;
  /** Maximum wall-clock time to wait. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Human-readable label used in the timeout error message (e.g. "export job"). */
  label: string;
  /**
   * Maximum consecutive transient (retryable) poll errors tolerated before
   * the last error is propagated. Transient errors (5xx / network) between
   * successful polls reset the counter. Defaults to 5.
   */
  maxTransientErrors?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRANSIENT_ERRORS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic classification used by {@link pollJobUntilDone} to decide whether
 * to retry a failed poll.
 *
 * - 5xx responses and unclassifiable network-style errors (fetch failed,
 *   ECONNRESET, etc.) are treated as transient.
 * - 4xx responses are treated as permanent, except 429 (rate limited) which is
 *   transient.
 * - "not found" errors are permanent — they indicate the job id is wrong and
 *   retrying won't help.
 *
 * The poll helpers (`platformPollJobStatus`, `localRuntimePollJobStatus`)
 * raise errors whose message contains the HTTP status (e.g. `"Local job
 * status check failed: 503 Service Unavailable"`), so we parse that out when
 * available and default to "retry" when unsure.
 */
function isTransientPollError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("not found")) return false;

  const match = msg.match(/(?:status check failed|failed)[^\d]*(\d{3})/i);
  if (match) {
    const code = parseInt(match[1], 10);
    if (code === 429) return true;
    if (code >= 400 && code < 500) return false;
    if (code >= 500) return true;
  }

  // Unclassifiable (e.g. "fetch failed", ECONNRESET) — treat as transient so
  // a single network hiccup doesn't abort a long-running migration.
  return true;
}

/**
 * Poll `options.poll` until it returns a terminal status (`complete` or
 * `failed`), or until `timeoutMs` elapses.
 *
 * On terminal status, returns the status object — including the `failed`
 * case. The caller decides how to treat a failed terminal status (e.g.
 * print the `error` field and exit). Timeouts throw.
 *
 * Transient errors raised by `poll()` (5xx, network hiccups, rate-limits) are
 * retried up to `maxTransientErrors` times before the last error propagates,
 * matching the pre-rewrite `platformPollExportStatus` loop's behavior so a
 * single flaky poll doesn't abort a migration that may still be running.
 */
export async function pollJobUntilDone(
  options: PollJobUntilDoneOptions,
): Promise<TerminalJobStatus> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTransientErrors =
    options.maxTransientErrors ?? DEFAULT_MAX_TRANSIENT_ERRORS;
  const deadline = Date.now() + timeoutMs;

  let consecutiveTransientErrors = 0;

  // First poll happens immediately so fast-path completions don't wait
  // one interval before returning.
  while (true) {
    let status: UnifiedJobStatus;
    try {
      status = await options.poll();
      consecutiveTransientErrors = 0;
    } catch (err) {
      if (!isTransientPollError(err)) {
        throw err;
      }
      consecutiveTransientErrors += 1;
      if (consecutiveTransientErrors > maxTransientErrors) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${options.label} polling failed, retrying... (${msg})`);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${options.label} after ${Math.round(
            timeoutMs / 1000,
          )}s`,
        );
      }
      await sleep(intervalMs);
      continue;
    }

    if (status.status === "complete" || status.status === "failed") {
      return status;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${options.label} after ${Math.round(
          timeoutMs / 1000,
        )}s`,
      );
    }

    await sleep(intervalMs);
  }
}
