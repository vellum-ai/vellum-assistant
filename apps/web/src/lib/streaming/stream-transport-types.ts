/**
 * Shared types for the SSE stream transport layer.
 *
 * Extracted so both the transport orchestrator (`stream-transport.ts`)
 * and the idle watchdog (`stream-watchdog.ts`) can reference them
 * without creating a circular dependency.
 */

export interface ChatEventStream {
  /** Cancel the stream. Safe to call multiple times. */
  cancel: () => void;
}

/**
 * Why the previous connection attempt was torn down. `"error"` covers
 * the SDK surfacing a fetch failure or the iterator ending; `"watchdog"`
 * means the client-side idle timer fired because no SSE traffic
 * (events or heartbeat comments) arrived within the configured window.
 * Threaded through to {@link ChatEventStreamOptions.onReconnect} so
 * callers can distinguish silent-stall recoveries from ordinary
 * transport errors when recording telemetry.
 */
export type ChatStreamReconnectCause = "error" | "watchdog";

export interface ChatEventStreamOptions {
  /**
   * Called after the SSE transport successfully reconnects. The events
   * endpoint is live-only, so callers should use this hook to reconcile
   * authoritative conversation history for messages emitted while
   * offline. The `cause` argument indicates whether the previous attempt
   * ended via a transport error or because the idle watchdog fired.
   */
  onReconnect?: (cause: ChatStreamReconnectCause) => void | Promise<void>;
  /**
   * Maximum interval, in milliseconds, with no SSE traffic from the
   * server (events OR heartbeat comments) before the client treats the
   * stream as silently stalled and force-reconnects.
   *
   * The fetch promise on iOS WKWebView (Capacitor) and some intermediate
   * proxies can hold a streaming connection open at the network layer
   * while no bytes flow through, with no error surfaced to JavaScript.
   * Without a client-side liveness check, the stream sits forever
   * waiting on the next byte. Defaults to {@link STREAM_IDLE_TIMEOUT_MS}.
   * Mainly exposed for tests.
   */
  idleTimeoutMs?: number;
  /**
   * Base delay, in milliseconds, used by the exponential-backoff
   * scheduler before the next reconnect attempt after a stream drop or
   * a watchdog-driven stall. Mainly exposed for tests.
   */
  reconnectBaseDelayMs?: number;
  /**
   * Snapshot whether the caller-owned turn state machine is currently in
   * a sending phase. When provided, the result is forwarded to Sentry on
   * watchdog fires as the `wasTurnSending` tag and extra so the
   * `sse_watchdog_fired` event count can be split into
   * user-harming (`true`: a stall while the user is waiting for an
   * in-flight assistant turn) vs benign (`false`: a stall on an idle
   * stream after a turn completed). Without this split, the 100%
   * `messagesAddedBucket=0` fleet reading collapses both populations and
   * is uninterpretable for the Layer 2 / Layer 3 decision. Optional;
   * defaults to omitting the tag entirely (Sentry treats absent tags as
   * `"<absent>"` in Discover grouping).
   *
   * Implementations should be cheap and synchronous — the callback fires
   * inside the watchdog `setTimeout` handler, before the abort cascade,
   * and must never throw.
   */
  getActiveTurnSending?: () => boolean;
}
