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

import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import {
  markClientEstablished,
  pushSseEvent,
  registerSseClient,
  unregisterSseClient,
} from "@/lib/streaming/stream-debug";
import { createStreamWatchdog } from "@/lib/streaming/stream-watchdog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSE stream transport
// ---------------------------------------------------------------------------

const STREAM_RECONNECT_BASE_DELAY_MS = 2000;
const STREAM_MAX_RECONNECT_ATTEMPTS = 5;
const STREAM_MAX_RECONNECT_DELAY_MS = 30_000;
// Idle watchdog: if no SSE traffic (events OR heartbeat comments) is
// received within this window, treat the stream as silently stalled
// and force-reconnect. The daemon emits a heartbeat comment every 30 s
// (see assistant/src/runtime/routes/events-routes.ts), so this value
// must comfortably exceed that interval to avoid false positives on a
// healthy connection that is idle between user turns.
const STREAM_IDLE_TIMEOUT_MS = 45_000;

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
export function subscribeChatEvents(
  assistantId: string,
  conversationId: string | null | undefined,
  onEvent: (envelope: AssistantEventEnvelope) => void,
  onError: (err: Error) => void,
  options: ChatEventStreamOptions = {},
): ChatEventStream {
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
  const requestedConversationId = conversationId ?? undefined;

  const watchdog = createStreamWatchdog({
    idleTimeoutMs,
    assistantId,
    conversationId: requestedConversationId,
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
    const sseDebugClientId = registerSseClient(
      abortController.signal,
      requestedConversationId,
    );
    // Reset per-attempt liveness counters so each watchdog fire
    // reports state for ITS attempt, not for the entire subscribe
    // lifetime.
    watchdog.resetCounters();
    let streamError: Error | null = null;
    try {
      // The wire-field gate prefers `conversationId` on daemons that
      // mint ids before the first client send, falling back to
      // `conversationKey` (create-or-lookup) so locally-minted draft
      // ids still resolve. See
      // `lib/backwards-compat/conversation-id-wire-field.ts`.
      const { stream } = await client.sse.get<Record<string, unknown> | string>(
        {
          url: "/v1/assistants/{assistant_id}/events/",
          path: { assistant_id: assistantId },
          ...(requestedConversationId
            ? {
                query: {
                  [pickConversationIdWireField()]: requestedConversationId,
                },
              }
            : {}),
          headers: {
            Accept: "text/event-stream, application/json",
            ...getClientRegistrationHeaders(),
          },
          signal: abortController.signal,
          // Keep reconnect behavior controlled by this function.
          sseMaxRetryAttempts: 1,
          onSseError: (error) => {
            streamError =
              error instanceof Error ? error : new Error("Stream disconnected");
          },
          onSseEvent: (event) => {
            // Fires for every parsed SSE chunk including heartbeat
            // comments (which the SDK surfaces with `data === undefined`
            // because comment frames have no `data:` line).
            const isData =
              typeof (event as { data?: unknown }).data !== "undefined";
            if (isData) {
              markClientEstablished(sseDebugClientId);
            }
            watchdog.recordTraffic(isData);
            if (!cancelled) {
              watchdog.arm(abortController, reconnectCount);
            }
          },
        },
      );

      if (isReconnect && !cancelled) {
        const cause: ChatStreamReconnectCause =
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

          const data =
            typeof payload === "string"
              ? (() => {
                  try {
                    const parsed = JSON.parse(payload);
                    if (
                      parsed &&
                      typeof parsed === "object" &&
                      !Array.isArray(parsed)
                    ) {
                      return parsed as Record<string, unknown>;
                    }
                  } catch {
                    // not JSON
                  }
                  return null;
                })()
              : payload &&
                  typeof payload === "object" &&
                  !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : null;

          if (!data) {
            continue;
          }

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
        onError(
          err instanceof Error ? err : new Error("Stream connection failed"),
        );
      }
    } finally {
      unregisterSseClient(sseDebugClientId);
    }
  };

  connect().catch((err) => {
    if (!cancelled) {
      onError(err instanceof Error ? err : new Error("Stream setup failed"));
    }
  });

  return { cancel };
}
