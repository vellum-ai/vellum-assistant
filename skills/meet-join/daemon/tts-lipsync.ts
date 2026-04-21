/**
 * TTS lip-sync forwarder — subscribes to a {@link MeetTtsBridge}'s viseme
 * channel and POSTs each event to the Meet-bot's `/avatar/viseme` endpoint
 * so the in-bot avatar renderer can drive blendshape weights against the
 * audio that the bot is simultaneously playing out.
 *
 * High-level flow:
 *   1. Caller builds a bridge (Phase 3) and calls {@link startTtsLipsync}.
 *   2. The forwarder subscribes to the bridge's `onViseme` channel.
 *   3. Each event is forwarded to the bot via `POST /avatar/viseme` and
 *      optionally fanned out to a local observer callback (tests, metrics).
 *   4. HTTP errors (including 404 when the bot hasn't yet deployed PR 5's
 *      endpoint, or 5xx during transient failures) are swallowed with a
 *      `debug`-level log — dropped events simply cause a visibly less
 *      synced avatar, not a crash or a dropped utterance.
 *   5. Caller invokes the returned `stop()` to unsubscribe and prevent
 *      further outbound HTTP traffic.
 *
 * The bot endpoint (`POST /avatar/viseme`) lands in PR 5 of the
 * meet-phase-4 plan; this PR lands the daemon producer in parallel.
 * Until PR 5 merges, bots respond 404 and the forwarder silently drops
 * those events — graceful degradation.
 */

import { getLogger } from "../../../assistant/src/util/logger.js";

import type { VisemeEvent, VisemeListener } from "./tts-bridge.js";

/**
 * Minimal bridge surface the forwarder reads — matches the overlap between
 * {@link MeetTtsBridge} and `MeetTtsBridgeLike` in session-manager.ts so
 * the session manager's narrow fake (or the real bridge) can be passed in
 * without casting.
 */
export interface TtsLipsyncBridge {
  readonly meetingId: string;
  readonly botBaseUrl: string;
  onViseme(listener: VisemeListener): () => void;
}

const log = getLogger("meet-tts-lipsync");

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Minimal fetch shape the forwarder needs — identical to the global
 * `fetch` but kept as an explicit dependency for tests.
 */
export type LipsyncFetchFn = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StartTtsLipsyncArgs {
  /** Bridge whose `onViseme` channel drives the forwarder. */
  bridge: TtsLipsyncBridge;
  /** Per-meeting bearer token — matches the token used for `/play_audio`. */
  botApiToken: string;
  /**
   * Optional fetch override (tests). Defaults to the global `fetch`.
   */
  fetch?: LipsyncFetchFn;
  /**
   * Optional observer invoked with every event _before_ the HTTP POST
   * fires. Used by tests and local metrics to assert which events reached
   * the forwarder irrespective of bot availability.
   */
  onEvent?: (event: VisemeEvent) => void;
  /**
   * Per-request timeout for the outbound POST. Kept short because a stuck
   * viseme POST would block subsequent events behind a `fetch` queue — we'd
   * rather drop a frame than fall minutes behind. Default 2 s.
   */
  requestTimeoutMs?: number;
}

/** Handle returned from {@link startTtsLipsync}. Call `stop()` on teardown. */
export interface TtsLipsyncHandle {
  /** Unsubscribe from the bridge's viseme channel. Idempotent. */
  stop(): void;
}

/**
 * Default HTTP timeout per `/avatar/viseme` POST. Individual events are
 * cheap and frequent (up to ~20/s during the amplitude-fallback path) —
 * we'd rather drop an event than let a pending POST linger.
 */
export const DEFAULT_LIPSYNC_REQUEST_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Start a forwarder that subscribes to `bridge.onViseme` and POSTs each
 * event to `${bridge.botBaseUrl}/avatar/viseme`. Returns a handle whose
 * `stop()` method unsubscribes — stopping is idempotent and safe to call
 * in teardown handlers that may also be triggered by a different code path.
 *
 * The forwarder is deliberately fire-and-forget at the HTTP layer:
 * `fetch` errors are logged at `debug` level and swallowed, so a bot that
 * hasn't deployed the `/avatar/viseme` route yet (404) or is briefly
 * unreachable (network hiccup) doesn't disrupt the speak pipeline. This
 * matches the plan's acceptance criterion: "Errors are tolerated —
 * dropped events just cause a visibly less-synced avatar, not a crash."
 */
export function startTtsLipsync(args: StartTtsLipsyncArgs): TtsLipsyncHandle {
  const {
    bridge,
    botApiToken,
    fetch: fetchImpl,
    onEvent,
    requestTimeoutMs,
  } = args;

  const timeoutMs = requestTimeoutMs ?? DEFAULT_LIPSYNC_REQUEST_TIMEOUT_MS;
  const doFetch: LipsyncFetchFn =
    fetchImpl ?? ((url, init) => fetch(url, init));
  const endpointUrl = `${bridge.botBaseUrl}/avatar/viseme`;

  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  const forward = (event: VisemeEvent): void => {
    if (stopped) return;
    try {
      onEvent?.(event);
    } catch (err) {
      log.debug(
        { err, meetingId: bridge.meetingId },
        "onEvent observer threw — suppressing",
      );
    }

    // Fire-and-forget POST. We do not await here because the listener is
    // called on the bridge's synchronous emit path and must return
    // immediately. The explicit `.catch` keeps unhandled rejections off
    // the global handler.
    const timeout = AbortSignal.timeout(timeoutMs);
    doFetch(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      signal: timeout,
    })
      .then(async (response) => {
        if (stopped) return;
        if (!response.ok) {
          log.debug(
            {
              meetingId: bridge.meetingId,
              status: response.status,
              phoneme: event.phoneme,
            },
            "POST /avatar/viseme returned non-2xx — dropping event",
          );
          // Drain so the connection can be reused.
          await response.arrayBuffer().catch(() => {});
          return;
        }
        await response.arrayBuffer().catch(() => {});
      })
      .catch((err) => {
        log.debug(
          { err, meetingId: bridge.meetingId, phoneme: event.phoneme },
          "POST /avatar/viseme failed — dropping event",
        );
      });
  };

  unsubscribe = bridge.onViseme(forward);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
    },
  };
}
