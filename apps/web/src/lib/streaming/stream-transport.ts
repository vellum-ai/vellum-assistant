/**
 * SSE stream transport for real-time assistant events.
 *
 * Opens an EventSource-style connection to the daemon's events endpoint,
 * automatically reconnects with exponential backoff, and delegates idle
 * detection to {@link createStreamWatchdog} to catch silently stalled
 * connections (notably on iOS WKWebView).
 */

import { client } from "@/generated/api/client.gen";
import { SDK_BASE_OPTIONS } from "@/utils/api-errors";
import { parseAssistantEvent } from "@/lib/streaming/event-parser";
import type { AssistantEvent } from "@/types/event-types";
import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import {
  markClientEstablished,
  pushSseEvent,
  registerSseClient,
  unregisterSseClient,
} from "@/lib/streaming/stream-debug";
import { createStreamWatchdog } from "@/lib/streaming/stream-watchdog";

export type {
  ChatEventStream,
  ChatEventStreamOptions,
  ChatStreamReconnectCause,
} from "@/lib/streaming/stream-transport-types";
import type {
  ChatEventStream,
  ChatEventStreamOptions,
  ChatStreamReconnectCause,
} from "@/lib/streaming/stream-transport-types";

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
  onEvent: (event: AssistantEvent) => void,
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
      const { stream } = await client.sse.get<Record<string, unknown> | string>({
        ...SDK_BASE_OPTIONS,
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
          streamError = error instanceof Error
            ? error
            : new Error("Stream disconnected");
        },
        onSseEvent: (event) => {
          // Fires for every parsed SSE chunk including heartbeat
          // comments (which the SDK surfaces with `data === undefined`
          // because comment frames have no `data:` line).
          const isData = typeof (event as { data?: unknown }).data !== "undefined";
          if (isData) {
            markClientEstablished(sseDebugClientId);
          }
          watchdog.recordTraffic(isData);
          if (!cancelled) {
            watchdog.arm(abortController, reconnectCount);
          }
        },
      });

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

          const data = typeof payload === "string"
            ? (() => {
              try {
                const parsed = JSON.parse(payload);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  return parsed as Record<string, unknown>;
                }
              } catch {
                // not JSON
              }
              return null;
            })()
            : payload && typeof payload === "object" && !Array.isArray(payload)
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

          // `parseAssistantEvent` owns the full path: envelope/flat
          // unwrap, canonical-schema dispatch, legacy-event coercion, and
          // envelope-conversationId stamping. This handler is the
          // transport — keep it thin.
          const parsed = parseAssistantEvent(data);
          pushSseEvent(sseDebugClientId, parsed);
          try {
            onEvent(parsed);
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
      onError(
        err instanceof Error ? err : new Error("Stream setup failed"),
      );
    }
  });

  return { cancel };
}
