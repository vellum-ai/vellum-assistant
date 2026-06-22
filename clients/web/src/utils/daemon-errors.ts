/**
 * Daemon error classification and retry utilities.
 *
 * Centralises detection of expected transient HTTP errors from daemon
 * API calls — startup races, auth-session hydration, org-header
 * propagation. Used by both Sentry error reporting (`captureError`) and
 * TanStack Query retry predicates.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-retries
 * - https://heyapi.dev/openapi-ts/clients/fetch#throwing-errors
 */

import { ApiError } from "@/utils/api-errors";

const MAX_DAEMON_RETRIES = 3;

/**
 * Detects expected transient HTTP errors from daemon API calls that
 * occur during normal startup sequences and auth-session hydration.
 *
 * - **503** — Daemon still starting up
 * - **502** — Reverse proxy cannot reach the daemon pod yet
 * - **401** — Auth session not yet established (race during login)
 * - **400 with org-header message** — Org store has not hydrated yet
 *
 * Only `ApiError` instances are matched. Other error types (TypeError,
 * generic Error, plain objects) pass through — they represent network
 * failures (handled by `isTransientNetworkError`) or application bugs.
 */
export function isExpectedDaemonTransientError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 503) return true;
  if (error.status === 502) return true;
  if (error.status === 401) return true;
  if (
    error.status === 400 &&
    error.message.includes("Organization-Id header")
  ) {
    return true;
  }
  return false;
}

/**
 * TanStack Query retry predicate for daemon queries.
 *
 * Retries expected transient errors (503 startup, 502 bad-gateway,
 * 401 auth-race, 400 org-header) up to {@link MAX_DAEMON_RETRIES}
 * times with TQ's built-in exponential backoff. Fails fast on
 * unexpected errors (500, data integrity, programming errors).
 *
 * ```ts
 * useQuery({
 *   queryKey: [...],
 *   queryFn: ...,
 *   retry: shouldRetryDaemonError,
 * });
 * ```
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/query-retries
 */
export function shouldRetryDaemonError(
  failureCount: number,
  error: Error,
): boolean {
  if (failureCount >= MAX_DAEMON_RETRIES) return false;
  return isExpectedDaemonTransientError(error);
}
