/**
 * Idle watchdog for SSE stream connections.
 *
 * Detects silently stalled connections — notably on iOS WKWebView
 * (Capacitor), where the fetch promise can hold a streaming connection
 * open at the network layer with no bytes flowing and no error surfaced
 * to JavaScript. The daemon emits a heartbeat comment every ~7 s; this
 * watchdog aborts the active fetch when no SSE traffic (events OR
 * heartbeat comments) arrives within a configurable window.
 *
 * Telemetry is recorded to the durable lifecycle diagnostics ring
 * (via {@link recordLifecycleDiagnostic}) and as a Sentry breadcrumb
 * that attaches to any nearby error event for debugging context.
 *
 * @see https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
 */

import * as Sentry from "@sentry/react";

import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import type { StreamReconnectCause } from "@/lib/streaming/stream-transport";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StreamWatchdogConfig {
  /** Milliseconds of silence before the watchdog fires. */
  idleTimeoutMs: number;
  assistantId: string;
  /**
   * Snapshot whether the caller-owned turn state machine is currently
   * sending. Forwarded to Sentry as the `wasTurnSending` tag so
   * user-harming stalls (during an in-flight turn) can be distinguished
   * from benign ones (idle stream after a turn completed).
   */
  getActiveTurnSending?: () => boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StreamWatchdog {
  /**
   * Reset (or arm) the idle timer for the given controller. Called
   * immediately before the for-await loop and on every parsed SSE
   * chunk — including heartbeat comments. If no traffic arrives
   * within `idleTimeoutMs`, the controller is aborted.
   */
  arm(controller: AbortController, attempt: number): void;
  /** Cancel any pending timer. */
  clear(): void;
  /** Reset per-attempt liveness counters (call on each new connect). */
  resetCounters(): void;
  /**
   * Record an SSE traffic event. `isData` distinguishes data frames
   * (yielded through the iterator) from heartbeat comment frames
   * (surfaced via `onSseEvent` with `data === undefined`).
   */
  recordTraffic(isData: boolean): void;
  /**
   * Return and clear the cause set by the most recent watchdog fire.
   * Returns `null` if the watchdog has not fired since the last
   * consume (or ever).
   */
  consumeLastAbortCause(): StreamReconnectCause | null;
}

/**
 * Create a watchdog instance that monitors SSE stream liveness.
 *
 * The returned handle encapsulates the timer, liveness counters, and
 * Sentry telemetry. The transport calls {@link StreamWatchdog.arm}
 * on every SSE chunk and {@link StreamWatchdog.clear} when the
 * read loop exits.
 */
export function createStreamWatchdog(
  config: StreamWatchdogConfig,
): StreamWatchdog {
  const { idleTimeoutMs, assistantId, getActiveTurnSending } = config;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSseAtMs: number | null = null;
  let keepalivesReceivedSinceConnect = 0;
  let dataFramesReceivedSinceConnect = 0;
  let lastAbortCause: StreamReconnectCause | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (controller: AbortController, attempt: number) => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      lastAbortCause = "watchdog";

      // Snapshot turn-sending state at the moment the watchdog fires.
      // This is the single most useful Sentry aggregation dimension:
      // it separates user-harming stalls (in-flight turn) from benign
      // ones (idle stream after turn complete). Defensively wrapped
      // because the caller-supplied snapshot is opaque.
      let wasTurnSending: boolean | null = null;
      try {
        wasTurnSending = getActiveTurnSending?.() ?? null;
      } catch {
        // Diagnostics are best-effort and must never block recovery.
      }

      // Distinguish "server never started responding" (null) from
      // "some traffic arrived then stopped" (positive age).
      const lastByteAgeMs =
        lastSseAtMs === null ? null : Date.now() - lastSseAtMs;

      recordLifecycleDiagnostic("sse_watchdog_fired", {
        assistantId,
        attempt,
        idleTimeoutMs,
        wasTurnSending,
        lastByteAgeMs,
        keepalivesReceivedSinceConnect,
        dataFramesReceivedSinceConnect,
      });

      // Breadcrumb-only: attaches to any nearby Sentry error event for
      // debugging context. No captureMessage — watchdog fires are
      // expected on iOS (background/foreground cycle) and generate
      // noise as a standalone Sentry issue. Fleet-wide stall frequency
      // belongs in an analytics pipeline, not Sentry issues.
      // @see https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
      Sentry.addBreadcrumb({
        category: "sse.watchdog",
        level: "warning",
        message: "watchdog_fired",
        data: {
          assistantId,
          attempt,
          idleTimeoutMs,
          wasTurnSending,
          lastByteAgeMs,
          keepalivesReceivedSinceConnect,
          dataFramesReceivedSinceConnect,
        },
      });

      controller.abort();
    }, idleTimeoutMs);
  };

  const resetCounters = () => {
    lastSseAtMs = null;
    keepalivesReceivedSinceConnect = 0;
    dataFramesReceivedSinceConnect = 0;
  };

  const recordTraffic = (isData: boolean) => {
    if (isData) {
      dataFramesReceivedSinceConnect++;
    } else {
      keepalivesReceivedSinceConnect++;
    }
    lastSseAtMs = Date.now();
  };

  const consumeLastAbortCause = (): StreamReconnectCause | null => {
    const cause = lastAbortCause;
    lastAbortCause = null;
    return cause;
  };

  return { arm, clear, resetCounters, recordTraffic, consumeLastAbortCause };
}
