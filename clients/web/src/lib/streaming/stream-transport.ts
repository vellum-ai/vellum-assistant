/**
 * SSE stream transport for real-time assistant events.
 *
 * Opens an EventSource-style connection to the daemon's events endpoint,
 * automatically reconnects with exponential backoff, and delegates idle
 * detection to {@link createStreamWatchdog} to catch silently stalled
 * connections (notably on iOS WKWebView).
 */

import { client } from "@/generated/api/client.gen";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { parseAssistantEvent } from "@/lib/streaming/event-parser";
import { normalizeSSEPayload } from "@/lib/streaming/sse-payload";
import { toError } from "@/utils/to-error";

import { getReconnectCursor } from "@/lib/streaming/reconnect-cursor";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import {
  type SseClientEndReason,
  endSseClient,
  markClientEstablished,
  pushSseEvent,
  recordSseTraffic,
  registerSseClient,
} from "@/lib/streaming/stream-debug";
import { createStreamWatchdog } from "@/lib/streaming/stream-watchdog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EventStream {
  /** Cancel the stream. Safe to call multiple times. */
  cancel: () => void;
}

/**
 * Why the previous connection attempt was torn down. `"error"` covers
 * the SDK surfacing a fetch failure or the iterator ending; `"watchdog"`
 * means the client-side idle timer fired because no SSE traffic
 * (events or heartbeat comments) arrived within the configured window.
 * Threaded through to {@link EventStreamOptions.onReconnect} so
 * callers can distinguish silent-stall recoveries from ordinary
 * transport errors when recording telemetry.
 */
export type StreamReconnectCause = "error" | "watchdog";

export interface EventStreamOptions {
  /**
   * Called after the SSE transport successfully reconnects. The events
   * endpoint is live-only, so callers should use this hook to reconcile
   * authoritative conversation history for messages emitted while
   * offline. The `cause` argument indicates whether the previous attempt
   * ended via a transport error or because the idle watchdog fired.
   */
  onReconnect?: (cause: StreamReconnectCause) => void | Promise<void>;
  /**
   * Fired when an SSE connection is genuinely established — the first frame
   * (a data event or a heartbeat comment) has arrived, proving the lazily
   * started fetch actually connected and bytes are flowing — for both the
   * initial connect and every internal reconnect attempt. Pairs with
   * {@link onStreamClose}.
   *
   * This is deliberately later than both the handle returned by
   * {@link subscribeEvents} (which exists synchronously, while the fetch is
   * still in flight and across every backoff retry) and the `client.sse.get`
   * await (which only builds the lazy generator — the fetch fires on the
   * first iterator pull). Keying off either would report "connected"
   * throughout a failing initial connect, when nothing is open.
   */
  onStreamOpen?: () => void;
  /**
   * Fired when an established connection attempt ends — transport error,
   * idle-watchdog abort, natural close, or cancel — before any reconnect
   * backoff begins. Pairs with {@link onStreamOpen}; only fires for attempts
   * that previously opened.
   */
  onStreamClose?: () => void;
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

// ---------------------------------------------------------------------------
// SSE stream transport
// ---------------------------------------------------------------------------

const STREAM_RECONNECT_BASE_DELAY_MS = 2000;
const STREAM_MAX_RECONNECT_ATTEMPTS = 5;
const STREAM_MAX_RECONNECT_DELAY_MS = 30_000;
// Idle watchdog: if no SSE traffic (events OR heartbeat comments) is
// received within this window, treat the stream as silently stalled
// and force-reconnect. The daemon emits a heartbeat comment every 7 s
// (DEFAULT_HEARTBEAT_INTERVAL_MS in events-routes.ts); in managed mode
// vembda injects additional keepalives every 10 s. This value must
// comfortably exceed both intervals to avoid false positives on a
// healthy connection that is idle between user turns.
const STREAM_IDLE_TIMEOUT_MS = 45_000;
// Query param carrying the resumable-stream reconnect cursor: the
// highest global event seq the client has already applied. The daemon
// replays every buffered event with seq > cursor on this one unfiltered
// stream. Must match the `lastSeenSeq` param parsed by
// assistant/src/runtime/routes/events-routes.ts.
const LAST_SEEN_SEQ_WIRE_FIELD = "lastSeenSeq";

/**
 * Build the query params for the events SSE connection.
 *
 * When a resumable cursor exists, attaches it
 * ({@link LAST_SEEN_SEQ_WIRE_FIELD}) so the daemon replays every
 * buffered event with `seq > cursor` from its global ring before going
 * live, rather than forcing a refetch. This applies to both a reconnect
 * (cursor = highest global seq received so far) and a cold connect that
 * has been anchored at a snapshot watermark `S` (see `cold-anchor.ts`):
 * the latter opens `/events?lastSeenSeq=S` so the gap between the
 * `/messages` snapshot and the stream attaching is replayed.
 *
 * A fresh page load with no cursor seeded yet has nothing to resume —
 * the cursor is `null` and the param is omitted, byte-identical to a
 * cursor-less cold connect.
 */
function buildEventsQuery(): Record<string, string> {
  const query: Record<string, string> = {};
  const cursor = getReconnectCursor();
  if (cursor !== null) {
    query[LAST_SEEN_SEQ_WIRE_FIELD] = String(cursor);
  }
  return query;
}

/**
 * Open an SSE connection to the assistant's events endpoint and emit typed
 * events via the provided callback.  Automatically reconnects with
 * exponential backoff when the stream drops (up to
 * {@link STREAM_MAX_RECONNECT_ATTEMPTS} times).  Falls back silently if
 * all attempts are exhausted — callers should use the existing polling
 * path as a fallback when `onError` fires.
 *
 * Returns a handle with a `cancel()` method to tear down the stream.
 */
export function subscribeEvents(
  assistantId: string,
  onEvent: (envelope: AssistantEventEnvelope) => void,
  onError: (err: Error) => void,
  options: EventStreamOptions = {},
): EventStream {
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const reconnectBaseDelayMs =
    options.reconnectBaseDelayMs ?? STREAM_RECONNECT_BASE_DELAY_MS;

  let cancelled = false;
  let reconnectCount = 0;
  // Each connect() attempt owns its own AbortController so the
  // idle-watchdog can interrupt a single attempt without poisoning
  // subsequent reconnects (sharing one controller across attempts
  // would leave its `aborted` signal latched after the first stall).
  // The top-level cancel() targets whichever attempt is currently
  // active.
  let activeAbortController: AbortController | null = null;

  const watchdog = createStreamWatchdog({
    idleTimeoutMs,
    assistantId,
    getActiveTurnSending: options.getActiveTurnSending,
  });

  const cancel = () => {
    cancelled = true;
    watchdog.clear();
    activeAbortController?.abort();
  };

  const reconnect = async (): Promise<boolean> => {
    if (cancelled || reconnectCount >= STREAM_MAX_RECONNECT_ATTEMPTS) {
      return false;
    }
    reconnectCount++;
    const delay = Math.min(
      reconnectBaseDelayMs * 2 ** (reconnectCount - 1),
      STREAM_MAX_RECONNECT_DELAY_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (cancelled) {
      return false;
    }
    await connect(true);
    return true;
  };

  const connect = async (isReconnect = false) => {
    if (cancelled) return;
    const abortController = new AbortController();
    activeAbortController = abortController;
    const sseDebugClientId = registerSseClient(abortController.signal);
    // Reset per-attempt liveness counters so each watchdog fire
    // reports state for ITS attempt, not for the entire subscribe
    // lifetime.
    watchdog.resetCounters();
    let streamError: Error | null = null;
    // Tracks whether this attempt ever received a frame. Gates the open /
    // close signals so liveness is mirrored off real traffic, and so a
    // never-established attempt never emits a spurious close.
    let streamOpened = false;
    try {
      const query = buildEventsQuery();
      const { stream } = await client.sse.get<Record<string, unknown> | string>(
        {
          url: "/v1/assistants/{assistant_id}/events/",
          path: { assistant_id: assistantId },
          ...(Object.keys(query).length > 0 ? { query } : {}),
          headers: {
            Accept: "text/event-stream, application/json",
            ...getClientRegistrationHeaders(),
          },
          signal: abortController.signal,
          // All reconnect behavior is owned by this function's
          // reconnect() loop — SDK-level retries would bypass the
          // watchdog, debug registry, reconnect cursor, and the
          // onReconnect reconciliation callback.
          sseMaxRetryAttempts: 0,
          onSseError: (error) => {
            streamError = toError(error, "Stream disconnected");
          },
          onSseEvent: (event) => {
            // Fires for every parsed SSE chunk including heartbeat
            // comments (which the SDK surfaces with `data === undefined`
            // because comment frames have no `data:` line).
            // The first frame of any kind proves the stream is genuinely
            // live — the lazy fetch connected and bytes are flowing — so
            // this, not handle creation or the generator-setup await, is
            // the real "connected" boundary. Pairs with onStreamClose.
            if (!cancelled && !streamOpened) {
              streamOpened = true;
              options.onStreamOpen?.();
            }
            const isData =
              typeof (event as { data?: unknown }).data !== "undefined";
            if (isData) {
              markClientEstablished(sseDebugClientId);
            }
            recordSseTraffic(sseDebugClientId, isData);
            watchdog.recordTraffic(isData);
            if (!cancelled) {
              watchdog.arm(abortController, reconnectCount);
            }
          },
        },
      );

      if (isReconnect && !cancelled) {
        const cause: StreamReconnectCause =
          watchdog.consumeLastAbortCause() ?? "error";
        try {
          await options.onReconnect?.(cause);
        } catch {
          // Callback errors should not trigger stream reconnect.
        }
      }

      // Arm the watchdog after the onReconnect callback resolves and
      // immediately before the for-await loop pulls the first chunk.
      // client.sse.get returns a lazy async generator — the
      // underlying fetch only kicks off on the first iterator pull —
      // and onReconnect performs an HTTP reconcile roundtrip that can
      // take several seconds. Arming the timer earlier would charge
      // that reconcile time against idleTimeoutMs and could abort
      // the new attempt before any SSE traffic ever started.
      if (!cancelled) {
        watchdog.arm(abortController, reconnectCount);
      }

      let receivedEvent = false;

      try {
        for await (const payload of stream) {
          if (cancelled) {
            return;
          }
          // Defensive double-reset on yielded data events. onSseEvent
          // has already covered this chunk, but resetting again here
          // wires the watchdog independently of the SDK's internal
          // callback ordering.
          watchdog.arm(abortController, reconnectCount);

          const data = normalizeSSEPayload(payload);
          if (!data) continue;

          // Stream proved healthy — reset the reconnect counter so transient
          // drops after a long-lived connection get a fresh budget.
          if (!receivedEvent) {
            receivedEvent = true;
            reconnectCount = 0;
          }

          const envelope = parseAssistantEvent(data);

          pushSseEvent(sseDebugClientId, envelope.message);
          try {
            onEvent(envelope);
          } catch {
            // Callback errors should not trigger stream reconnect
          }
        }
      } finally {
        // The watchdog only protects the for-await read loop. Clear
        // here so any timer still armed when the loop exits — via
        // natural end, abort, SDK transport error, or cancel — cannot
        // fire after the attempt has ended. Without this, a non-stall
        // teardown that happens close to the idle deadline lets the
        // timer run during the reconnect backoff and falsely set
        // lastAbortCause = "watchdog" on a recoverable error path.
        watchdog.clear();
        // An attempt that actually opened has now ended (drop, error,
        // watchdog abort, natural close, or cancel) — fired before
        // reconnect() schedules the next attempt, so a backoff window
        // reads as disconnected. Gated on streamOpened so a connect that
        // never received a frame doesn't emit a spurious close. Pairs
        // with onStreamOpen.
        if (streamOpened) {
          options.onStreamClose?.();
        }
      }
      if (cancelled) {
        return;
      }
      if (streamError) {
        const reconnected = await reconnect();
        if (!reconnected) {
          onError(streamError);
        }
        return;
      }
      const reconnected = await reconnect();
      if (!reconnected) {
        onError(new Error("Stream ended unexpectedly"));
      }
    } catch (err) {
      if (cancelled) return;
      const reconnected = await reconnect();
      if (!reconnected) {
        onError(toError(err, "Stream connection failed"));
      }
    } finally {
      // Report the connection's end reason to the debug registry, which
      // retains it (with its final counters) for post-hoc diagnosis.
      // `cancelled` (consumer teardown) and the watchdog are the only
      // things that abort the signal, so a non-cancel abort is the
      // watchdog's idle-timeout fire.
      let endReason: SseClientEndReason;
      if (cancelled) {
        endReason = "cancelled";
      } else if (abortController.signal.aborted) {
        endReason = "watchdog";
      } else if (streamError) {
        endReason = "error";
      } else {
        endReason = "ended";
      }
      endSseClient(sseDebugClientId, endReason);
    }
  };

  connect().catch((err) => {
    if (!cancelled) {
      onError(toError(err, "Stream setup failed"));
    }
  });

  return { cancel };
}
