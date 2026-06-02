import * as Sentry from "@sentry/react";

import { isTransientNetworkError } from "@/utils/is-transient-network-error";

/**
 * Captures a non-transient error to Sentry with structured tags.
 *
 * Transient browser-level fetch failures (network drop, DNS timeout,
 * device sleep) are silently dropped — they are not application bugs
 * and the app handles them gracefully via TanStack Query retries,
 * best-effort sync patterns, and error-state UI.
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
    extra?: Record<string, unknown>;
  },
): void {
  if (isTransientNetworkError(error)) return;
  console.error(`[${opts.context}]`, error);
  Sentry.captureException(error, {
    level: opts.level,
    tags: { context: opts.context },
    ...(opts.extra ? { extra: opts.extra } : {}),
  });
}
