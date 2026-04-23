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
  /** Maximum wall-clock time to wait. Defaults to 60 minutes. */
  timeoutMs?: number;
  /** Human-readable label used in the timeout error message (e.g. "export job"). */
  label: string;
  /**
   * Maximum consecutive transient (retryable) poll errors tolerated before
   * the last error is propagated. Transient errors (5xx / network) between
   * successful polls reset the counter. Defaults to 5.
   */
  maxTransientErrors?: number;
  /**
   * Optional async hook invoked when `poll()` throws an error containing a
   * `401` HTTP status. The callback is expected to refresh whatever
   * credential the poll closure reads (e.g. re-lease a guardian token), then
   * return. The polling loop will retry the poll after the callback resolves
   * instead of propagating the 401.
   *
   * Used by long-running migrations where the cached access token may expire
   * mid-poll. Without this hook, 4xx errors (except 429) are permanent and
   * would abandon a migration that's still running on the server.
   */
  refreshOn401?: () => Promise<void>;
  /**
   * Maximum consecutive 401 refreshes tolerated before the last 401 is
   * propagated. Tracked separately from {@link maxTransientErrors} because
   * a persistent 401 after a refresh usually means the underlying credential
   * is revoked, not a transient network issue. Defaults to 3.
   */
  maxAuthRefreshes?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
// Matches the server-side runtime migration window: the GCS upload PUT and
// the import-URL fetch in assistant/src/runtime/routes/migration-routes.ts
// use AbortSignal.timeout(60 * 60 * 1000), so a shorter CLI poll cap would
// abort a job that's still legitimately in progress on the server.
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TRANSIENT_ERRORS = 5;
const DEFAULT_MAX_AUTH_REFRESHES = 3;

function is401Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b/.test(msg);
}

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
  const maxAuthRefreshes =
    options.maxAuthRefreshes ?? DEFAULT_MAX_AUTH_REFRESHES;
  const deadline = Date.now() + timeoutMs;

  let consecutiveTransientErrors = 0;
  let consecutiveAuthRefreshes = 0;

  // First poll happens immediately so fast-path completions don't wait
  // one interval before returning.
  while (true) {
    let status: UnifiedJobStatus;
    try {
      status = await options.poll();
      consecutiveTransientErrors = 0;
      consecutiveAuthRefreshes = 0;
    } catch (err) {
      // 401 Unauthorized takes precedence over the generic transient
      // classifier: when a refresh callback is registered, a long-running
      // poll loop can re-lease its credential and keep going instead of
      // abandoning a migration that's still running on the server.
      if (options.refreshOn401 && is401Error(err)) {
        consecutiveAuthRefreshes += 1;
        if (consecutiveAuthRefreshes > maxAuthRefreshes) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${options.label} polling got 401, refreshing auth and retrying... (${msg})`,
        );
        await options.refreshOn401();
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
