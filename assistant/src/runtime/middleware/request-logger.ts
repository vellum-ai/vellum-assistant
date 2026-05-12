/**
 * HTTP request/response logging middleware.
 *
 * Logs method, path, status, and latency for every request to aid
 * debugging client issues. Uses structured Pino logging.
 *
 * Routes can opt in to suppress the per-request INFO line after a confirmed
 * run of N successful responses by declaring `logging.silenceSuccessAfter`
 * on the route definition. Warning (4xx) and error (5xx) lines are always
 * emitted regardless of this setting.
 */

import { getLogger } from "../../util/logger.js";
import type { RouteLoggingConfig } from "../routes/types.js";

const log = getLogger("http-request");

const UNKNOWN = "unknown" as const;

/**
 * Optional metadata supplied by the caller (typically resolved from the
 * matched route) that lets the middleware adjust its per-request log
 * behavior — e.g. suppressing success logs after a threshold for noisy
 * polling endpoints like `/v1/health`.
 */
export interface RequestLogMetadata {
  /**
   * Stable identifier used as the success-suppression counter key. Two
   * requests with the same counterKey share a single counter (so all
   * variants of a parameterized route share suppression state).
   */
  counterKey: string;
  config: RouteLoggingConfig;
}

// Module-level counter map. Tracks the cumulative number of successful
// (status < 400) responses logged per `counterKey`. Once the count passes
// the route's `silenceSuccessAfter` threshold, further successful responses
// skip the per-request INFO log line. Counters never reset within a
// process — the behavior is "the route worked, stop spamming".
const successCounters = new Map<string, number>();

/**
 * Test-only: reset the per-route success counters. Production code never
 * calls this; tests use it to isolate suppression state between cases.
 */
export function _resetRequestLoggingCountersForTests(): void {
  successCounters.clear();
}

/**
 * Decide whether the success log line should be suppressed for this
 * request. Returns true when the counter has already reached the
 * configured threshold. Pure read — the counter is only mutated when
 * the log line is actually emitted.
 */
function shouldSuppressSuccess(meta: RequestLogMetadata | undefined): boolean {
  if (!meta) return false;
  const threshold = meta.config.silenceSuccessAfter;
  if (threshold === undefined || threshold <= 0) return false;
  const current = successCounters.get(meta.counterKey) ?? 0;
  return current >= threshold;
}

/** Record that we just emitted a success log line for this route. */
function bumpSuccessCounter(meta: RequestLogMetadata | undefined): void {
  if (!meta) return;
  if (meta.config.silenceSuccessAfter === undefined) return;
  const current = successCounters.get(meta.counterKey) ?? 0;
  successCounters.set(meta.counterKey, current + 1);
}

/**
 * Wrap a request handler to log request metadata and response timing.
 *
 * The handler may return `undefined` for WebSocket upgrades (Bun consumes
 * the request and there is no HTTP response to send).
 */
export async function withRequestLogging(
  req: Request,
  handler: () => Promise<Response>,
  meta?: RequestLogMetadata,
): Promise<Response> {
  const start = performance.now();
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  let response: Response;
  try {
    response = await handler();
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    log.error(
      { method, path, latencyMs, err },
      `${method} ${path} -> error (${latencyMs}ms)`,
    );
    throw err;
  }

  const latencyMs = Math.round(performance.now() - start);

  // WebSocket upgrades return undefined — log and pass through without
  // dereferencing response properties.
  if (!response) {
    log.info(
      { method, path, latencyMs },
      `${method} ${path} -> ws-upgrade (${latencyMs}ms)`,
    );
    return response;
  }

  const status = response.status;

  const logData = {
    method,
    path,
    status,
    latencyMs,
    interfaceId: req.headers.get("x-vellum-interface-id") ?? UNKNOWN,
    contentType: req.headers.get("content-type") ?? UNKNOWN,
    userAgent: req.headers.get("user-agent") ?? UNKNOWN,
  };

  if (status >= 500) {
    log.error(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
  } else if (status >= 400) {
    log.warn(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
  } else if (!shouldSuppressSuccess(meta)) {
    log.info(logData, `${method} ${path} -> ${status} (${latencyMs}ms)`);
    bumpSuccessCounter(meta);
  }

  return response;
}
