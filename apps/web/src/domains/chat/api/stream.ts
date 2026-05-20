/**
 * SSE stream transport for real-time assistant events.
 *
 * Opens an EventSource-style connection to the daemon's events endpoint,
 * automatically reconnects with exponential backoff, and includes an idle
 * watchdog to detect silently stalled connections (notably on iOS WKWebView).
 */

import * as Sentry from "@sentry/browser";

import { client, SDK_BASE_OPTIONS } from "@/domains/chat/api/client.js";
import { recordChatDiagnostic, resolvePlatformTag } from "@/domains/chat/utils/diagnostics.js";
import { parseAssistantEvent, readEventConversationKey } from "@/domains/chat/api/event-parser.js";
import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity.js";

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
  conversationKey: string | null | undefined,
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
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const requestedConversationKey = conversationKey ?? undefined;
  // Cause of the most recent connect attempt teardown, consumed by the
  // next reconnect when it invokes onReconnect. `"watchdog"` is set
  // by armWatchdog before it aborts; left null otherwise so the
  // reconnect path defaults to `"error"`.
  let lastAbortCause: ChatStreamReconnectCause | null = null;
  // Per-attempt liveness counters used to enrich the `sse_watchdog_fired`
  // Sentry event with context about what (if anything) was flowing on
  // the connection in the moments before the stall. These distinguish
  // "no traffic at all since connect" (server never began responding)
  // from "keepalives but no data" (vembda alive, daemon silent) from
  // "data flowing but then stopped mid-turn" (mid-turn upstream death).
  // Reset on every connect attempt so each watchdog fire reports the
  // counts for its own attempt, not the cumulative session.
  let lastSseAtMs: number | null = null;
  let keepalivesReceivedSinceConnect = 0;
  let dataFramesReceivedSinceConnect = 0;

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  // Reset (or arm) the idle watchdog for the supplied attempt. Called
  // immediately before the for-await loop is entered and on every
  // parsed SSE chunk thereafter — including heartbeat comments, which
  // the SDK surfaces via onSseEvent even though they do not yield
  // through the iterator. If no traffic arrives within idleTimeoutMs,
  // abort the active fetch so the outer reconnect path runs; some
  // runtimes (notably WKWebView on Capacitor iOS) hold a streaming
  // fetch open at the network layer with no bytes flowing and no
  // error surfaced to JavaScript, so server-side heartbeats are only
  // a useful liveness signal if the client checks them.
  const armWatchdog = (controller: AbortController) => {
    if (cancelled) return;
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      lastAbortCause = "watchdog";
      // Snapshot liveness state at the moment the watchdog fires.
      // `wasTurnSending` is the single most useful aggregation
      // dimension Sentry currently lacks: the 100% bucket=0
      // reading collapses "benign idle stall after turn complete"
      // and "user-harming stall during in-flight turn" into the
      // same population, which makes the L2/L3 decision
      // uninterpretable. Defensively wrap in try/catch because the
      // caller-supplied snapshot is opaque to us; an exception here
      // would prevent the diagnostic from being recorded.
      let wasTurnSending: boolean | null = null;
      try {
        wasTurnSending = options.getActiveTurnSending?.() ?? null;
      } catch {
        // Diagnostics are best-effort and must never block recovery.
      }
      // `lastByteAgeMs` distinguishes "server never started responding
      // to this attempt" (lastSseAtMs === null) from "some traffic
      // arrived then stopped" (a positive age). With idleTimeoutMs
      // = 45s a healthy heartbeat-driven idle stream sees ageMs
      // ≤ the daemon's heartbeat interval just before the timer is
      // reset, so an age > idleTimeoutMs at fire time would indicate
      // the timer is running ahead of the bytes it's supposed to be
      // resetting on — i.e. the SDK's onSseEvent callback is not
      // firing for some frame shape. That alone would be a fix.
      const lastByteAgeMs =
        lastSseAtMs === null ? null : Date.now() - lastSseAtMs;
      // Record before aborting so the diagnostic captures the
      // attempt that actually stalled, even if the abort cascade
      // tears state down before the next reconnect runs.
      recordChatDiagnostic("sse_watchdog_fired", {
        assistantId,
        conversationKey: requestedConversationKey ?? null,
        attempt: reconnectCount,
        idleTimeoutMs,
        wasTurnSending,
        lastByteAgeMs,
        keepalivesReceivedSinceConnect,
        dataFramesReceivedSinceConnect,
      });
      // Mirror the same event into Sentry. sessionStorage events
      // only ship off-device when a user manually attaches a
      // diagnostics bundle, which biases the sample toward
      // broken-and-noisy cases — exactly the cases the silent
      // stall this watchdog detects is NOT. Sentry breadcrumbs
      // attach to every subsequent error and captureMessage gives
      // an aggregable count, so fleet-wide data answers the
      // Layer 2 / Layer 3 question even when users never submit a
      // bundle.
      // https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
      Sentry.addBreadcrumb({
        category: "sse.watchdog",
        level: "warning",
        message: "watchdog_fired",
        data: {
          assistantId,
          attempt: reconnectCount,
          idleTimeoutMs,
          wasTurnSending,
          lastByteAgeMs,
          keepalivesReceivedSinceConnect,
          dataFramesReceivedSinceConnect,
        },
      });
      Sentry.captureMessage("sse_watchdog_fired", {
        level: "warning",
        // platform is the only fleet-wide signal that distinguishes
        // Capacitor iOS from Safari iOS — Sentry's auto-detected
        // os.name does not, but LUM-1431 is iOS-only so the L2/L3
        // decision needs the breakdown. tags are aggregable in
        // Discover; extras are not. wasTurnSending is promoted to a
        // tag so the user-harming vs benign split can be queried in
        // one Discover groupBy without per-event drill-in.
        // https://docs.sentry.io/product/explore/discover-queries/
        // https://docs.sentry.io/concepts/key-terms/key-terms/#tags
        tags: {
          context: "sse_watchdog",
          platform: resolvePlatformTag(),
          attempt: String(reconnectCount),
          wasTurnSending:
            wasTurnSending === null ? "unknown" : String(wasTurnSending),
        },
        extra: {
          assistantId,
          conversationKey: requestedConversationKey ?? null,
          attempt: reconnectCount,
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

  const cancel = () => {
    cancelled = true;
    clearWatchdog();
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
    // Reset per-attempt liveness counters so each watchdog fire
    // reports state for ITS attempt, not for the entire subscribe
    // lifetime. lastSseAtMs stays null until the first SSE chunk
    // arrives so the diagnostic can distinguish "server never
    // responded" from "some traffic then stalled".
    lastSseAtMs = null;
    keepalivesReceivedSinceConnect = 0;
    dataFramesReceivedSinceConnect = 0;
    let streamError: Error | null = null;
    try {
      const { stream } = await client.sse.get<Record<string, unknown> | string>({
        ...SDK_BASE_OPTIONS,
        url: "/v1/assistants/{assistant_id}/events/",
        path: { assistant_id: assistantId },
        ...(requestedConversationKey
          ? { query: { conversationKey: requestedConversationKey } }
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
          // because comment frames have no `data:` line). Hooking
          // the watchdog reset here is what makes the timeout safe
          // in the foreground: a healthy idle connection still
          // receives a heartbeat every ~30s between user turns and
          // will not be force-reconnected.
          //
          // Counting heartbeats vs data frames separately lets the
          // watchdog diagnostic distinguish "vembda alive, daemon
          // silent" (keepalives > 0, dataFrames = 0) from
          // "stream died mid-turn" (keepalives ≥ 0, dataFrames > 0)
          // from "server never started responding" (both 0).
          // event.data is typed as TData but is undefined at runtime
          // for comment-only chunks per @hey-api SDK semantics; the
          // cast lets the runtime check stay precise without
          // relying on a type assertion at every read.
          if (typeof (event as { data?: unknown }).data === "undefined") {
            keepalivesReceivedSinceConnect++;
          } else {
            dataFramesReceivedSinceConnect++;
          }
          lastSseAtMs = Date.now();
          armWatchdog(abortController);
        },
      });

      if (isReconnect && !cancelled) {
        const cause: ChatStreamReconnectCause = lastAbortCause ?? "error";
        lastAbortCause = null;
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
      armWatchdog(abortController);

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
          armWatchdog(abortController);

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

          // Support envelope format: { message: { type, ...fields } }
          // with fallback to flat format: { type, ...fields }
          let eventData = data;
          if (
            data.message &&
            typeof data.message === "object" &&
            !Array.isArray(data.message) &&
            typeof (data.message as Record<string, unknown>).type === "string"
          ) {
            eventData = data.message as Record<string, unknown>;
          }

          const envelopeConversationKey = readEventConversationKey(data);
          const eventType = typeof eventData.type === "string" ? eventData.type : "message";
          const parsed = parseAssistantEvent(eventType, eventData);
          parsed.conversationKey =
            parsed.conversationKey ??
            envelopeConversationKey ??
            requestedConversationKey;
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
        clearWatchdog();
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
