import * as Sentry from "@sentry/react";

import { ApiError } from "@/utils/api-errors";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";

/**
 * Normalizes a thrown value into a proper `Error` instance so Sentry
 * can extract a useful title and stack trace.
 *
 * HeyAPI's `throwOnError: true` throws the HTTP response body verbatim
 * as a plain object (e.g. `{ detail: "..." }`). Sentry can only group
 * and display `Error` instances meaningfully — plain objects produce
 * "Object captured as exception with keys: ..." titles with no stack.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/usage/#capturing-errors
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#throwing-errors
 */
export function normalizeToError(value: unknown): Error {
  if (value instanceof Error) return value;

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const detail = obj.detail;
    if (typeof detail === "string") {
      const err = new Error(detail);
      err.cause = value;
      return err;
    }
    const message = obj.message;
    if (typeof message === "string") {
      const err = new Error(message);
      err.cause = value;
      return err;
    }
    try {
      const err = new Error(JSON.stringify(value));
      err.cause = value;
      return err;
    } catch {
      const err = new Error("Non-serializable error object");
      err.cause = value;
      return err;
    }
  }

  return new Error(String(value));
}

/**
 * Detects expected transient HTTP errors from daemon API calls that
 * occur during normal startup sequences and auth-session hydration.
 *
 * These are valid HTTP responses (not browser-level network failures)
 * that indicate the daemon or its infrastructure is not yet ready:
 *
 * - **503** — Daemon still starting up ("Your assistant is still starting up")
 * - **502** — Reverse proxy cannot reach the daemon pod yet
 * - **401** — Auth session not yet established (race during login)
 * - **400 with org-header message** — Org store has not hydrated yet;
 *   the `Vellum-Organization-Id` header interceptor read `null`
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
 * Captures a non-transient error to Sentry with structured tags.
 *
 * Transient browser-level fetch failures (network drop, DNS timeout,
 * device sleep) are silently dropped — they are not application bugs
 * and the app handles them gracefully via TanStack Query retries,
 * best-effort sync patterns, and error-state UI.
 *
 * When `bestEffort` is `true`, expected daemon transient HTTP errors
 * (503/502/401/400-org-header) are also silently dropped. Use this for
 * background fetches that fire optimistically and have natural retry
 * surfaces (SSE reconnect, dependency-change re-renders, navigation).
 *
 * Non-Error values (e.g. HeyAPI response bodies thrown by
 * `throwOnError: true`) are normalized into `Error` instances before
 * capture so Sentry produces useful titles and grouping.
 *
 * All manual error reporting should go through this function so that
 * transient-error filtering, consent gating, and tag conventions are
 * applied consistently. The only exceptions are framework-level
 * captures (`RouterProvider.onError`, `Sentry.ErrorBoundary`) which
 * need the raw Sentry API for scope manipulation.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/usage/#capturing-errors
 */
export function captureError(
  error: unknown,
  opts: {
    context: string;
    level?: Sentry.SeverityLevel;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    bestEffort?: boolean;
  },
): void {
  if (isTransientNetworkError(error)) return;
  if (opts.bestEffort && isExpectedDaemonTransientError(error)) return;
  console.error(`[${opts.context}]`, error);

  const normalized = normalizeToError(error);
  const extra: Record<string, unknown> = { ...opts.extra };
  if (normalized !== error) {
    extra.originalError = error;
  }

  Sentry.captureException(normalized, {
    level: opts.level,
    tags: { context: opts.context, ...opts.tags },
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });
}
