/**
 * Global TanStack Query retry policy.
 *
 * The default react-query behaviour retries every failed query 3× — including
 * `429 Too Many Requests`. Against the daemon's 300 req/min limiter that is
 * self-defeating: once a burst (window-focus refetch, reconnect, many queries
 * at once) crosses the limit, retrying the 429s keeps the request rate pinned
 * above the limit so it never recovers — a sustained 429 storm. This predicate
 * never retries rate-limited (429) or other 4xx client errors (they don't
 * self-heal), and retries only transient server (5xx) and network errors.
 *
 * Per-query `retry` options still override this default, so queries that opt
 * into `shouldRetryDaemonError` (401 auth-race, 503 startup) or `retry: false`
 * keep their own behaviour.
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/query-retries
 */

import { ApiError } from "@/utils/api-errors";

const MAX_RETRIES = 3;

/**
 * Best-effort HTTP status extraction across the error shapes our query
 * functions throw: {@link ApiError} (carries `status`), HeyAPI client errors
 * (a `status` field), and `Response`-shaped errors (`response.status`).
 * Returns `undefined` for network errors / non-HTTP failures.
 */
export function httpStatusFromError(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; response?: { status?: unknown } };
    if (typeof e.status === "number") return e.status;
    if (e.response && typeof e.response.status === "number") {
      return e.response.status;
    }
  }
  return undefined;
}

/**
 * Default retry predicate: never retry a 4xx (especially 429), retry transient
 * 5xx / network errors up to {@link MAX_RETRIES}.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  const status = httpStatusFromError(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return true;
}

/** Capped exponential backoff: 1s, 2s, 4s, … capped at 30s. */
export function queryRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
