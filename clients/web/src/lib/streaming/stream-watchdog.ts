/**
 * Web/iOS SSE idle watchdog: the shared timer plus surface telemetry.
 *
 * Detects silently stalled connections, notably on iOS WKWebView
 * (Capacitor), where the fetch promise can hold a streaming connection
 * open at the network layer with no bytes flowing and no error surfaced
 * to JavaScript. Telemetry is recorded to the durable lifecycle
 * diagnostics ring and as a Sentry breadcrumb that attaches to any
 * nearby error event for debugging context.
 *
 * @see https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
 */

import * as Sentry from "@sentry/react";
import {
  createIdleWatchdog,
  type IdleWatchdog,
} from "@vellumai/sse-idle-watchdog";

import { recordLifecycleDiagnostic } from "@/lib/diagnostics";

export type { IdleWatchdog as StreamWatchdog };

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

/**
 * Create a watchdog instance that monitors SSE stream liveness and
 * records web-specific telemetry on fire.
 */
export function createStreamWatchdog(
  config: StreamWatchdogConfig,
): IdleWatchdog {
  const { idleTimeoutMs, assistantId, getActiveTurnSending } = config;

  return createIdleWatchdog({
    idleTimeoutMs,
    onFire: (info) => {
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

      recordLifecycleDiagnostic("sse_watchdog_fired", {
        assistantId,
        attempt: info.attempt,
        idleTimeoutMs: info.idleTimeoutMs,
        wasTurnSending,
        lastByteAgeMs: info.lastByteAgeMs,
        keepalivesReceivedSinceConnect: info.keepalivesReceivedSinceConnect,
        dataFramesReceivedSinceConnect: info.dataFramesReceivedSinceConnect,
      });

      // Breadcrumb-only: attaches to any nearby Sentry error event for
      // debugging context. No captureMessage. Watchdog fires are
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
          attempt: info.attempt,
          idleTimeoutMs: info.idleTimeoutMs,
          wasTurnSending,
          lastByteAgeMs: info.lastByteAgeMs,
          keepalivesReceivedSinceConnect: info.keepalivesReceivedSinceConnect,
          dataFramesReceivedSinceConnect: info.dataFramesReceivedSinceConnect,
        },
      });
    },
  });
}
