/**
 * `useLiveVoice()` — session controller for the browser live-voice channel.
 *
 * It wires the three merged primitives — {@link LiveVoiceChannelClient}
 * (transport), {@link LiveVoiceAudioCapture} (mic → PCM), {@link
 * LiveVoiceAudioPlayer} (TTS playback) — into the session state machine and
 * projects observable state into
 * {@link useLiveVoiceStore}.
 *
 * The state machine is held in `useLiveVoiceStore`; this module owns the imperative
 * glue (event wiring, barge-in, automatic push-to-talk release, teardown). One
 * controller instance drives at most one session at a time; `start()` while a
 * session is live is a no-op.
 *
 * ## Session modes
 * A session runs in one of two modes, chosen at `start()`:
 *
 * **Manual (push-to-talk, default)** — exactly one utterance → one response.
 * The runtime (and the macOS reference) treat `ptt_release` as terminal: once
 * released, the session never re-accepts audio (sending more yields
 * `invalid_audio_payload`). So this controller does NOT keep one socket open
 * across turns — after the assistant finishes speaking it ends the session
 * (→ idle), and the user starts a fresh one for the next turn. Barge-in is the
 * one case that reconnects automatically (see below).
 *
 * **Hands-free (`handsFree` start option — how the voice button always starts
 * sessions)** — the session connects with `turnDetection: "server_vad"` and runs
 * many turns on one socket. Mic audio is forwarded for the entire session
 * (full duplex; echo cancellation is requested on capture) and the *server*
 * owns utterance boundaries and barge-in: `speech_started` flushes local TTS
 * playback and opens the next utterance, `utterance_end` marks transcription,
 * and `turn_cancelled` drops a barged-in turn's playback. The client-local
 * silence auto-release and amplitude barge-in below are disabled in this mode.
 * The session ends only on user toggle-off, `busy`, a terminal `error`, or
 * socket close — errors the daemon marks `recoverable` (transient transcriber
 * or per-segment TTS failures) keep the conversation alive. If the daemon's
 * `ready` does not echo `turnDetection: "server_vad"` (older daemon that
 * ignored the request), the session falls back to full manual behavior so it
 * still works instead of hanging.
 *
 * ## State transitions
 * Manual (one session = one turn): `idle → connecting` (start) → `listening`
 * (ready + capture started) → `transcribing` (ptt released) → `thinking`
 * (server response) → `speaking` (tts_audio) → `idle` (tts_done drained →
 * session ended). Hands-free cycles instead of ending: `speaking` →
 * (tts_done drained) → `listening` → `transcribing` (utterance_end) → … .
 * The mic keeps capturing for the whole session; `stop()`, teardown, an error,
 * a server `archived`/`closed`, or (manual) end-of-response returns to
 * `idle`/`failed`.
 *
 * ## Mic forwarding
 * The mic capture graph runs for the entire active session so amplitude keeps
 * flowing for barge-in even while the assistant is thinking/speaking. Audio
 * *forwarding* (`session.forwardingAudio`) is gated to the user's turn in
 * manual mode: captured PCM is streamed only while forwarding is on.
 * Push-to-talk release flips forwarding off (without stopping the mic); it is
 * not re-opened within a manual session (single-utterance — see above). In
 * hands-free mode forwarding stays on for the whole session.
 *
 * ## Barge-in (manual mode)
 * While `speaking`, a captured amplitude over {@link BARGE_IN_AMPLITUDE_THRESHOLD}
 * stops playback, sends `interrupt` (once per response), and ends the session
 * (→ idle) — the interrupted session is terminal on the runtime, so the user
 * starts a fresh session to respond. (Seamless reconnect-on-barge-in is a
 * follow-up.) In hands-free mode the server detects barge-in instead.
 *
 * ## Automatic push-to-talk release (manual mode)
 * While `listening`, sustained speech (≥ {@link MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS})
 * followed by {@link SILENCE_DURATION_BEFORE_RELEASE_MS} of silence releases
 * push-to-talk and moves to `transcribing` (mic stays open). In hands-free
 * mode the server VAD owns utterance boundaries.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  LiveVoiceChannelClient,
  RETRYABLE_LIVE_VOICE_CLOSE_CODES,
  type LiveVoiceClientError,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import {
  LiveVoiceAudioCapture,
  LIVE_VOICE_AUDIO_FORMAT,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import {
  LiveVoiceAudioPlayer,
  type TtsAudioChunk,
} from "@/domains/chat/voice/live-voice/tts-playback";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

// ---------------------------------------------------------------------------
// Thresholds (mirror the macOS LiveVoiceChannelManager defaults)
// ---------------------------------------------------------------------------

/** Mic amplitude (in [0, 1]) above which barge-in interrupts assistant speech. */
const BARGE_IN_AMPLITUDE_THRESHOLD = 0.05;

/** Mic amplitude above which a chunk counts as speech (for silence detection). */
const SPEECH_AMPLITUDE_THRESHOLD = 0.03;

/** Trailing silence (ms) after speech that triggers an automatic ptt_release. */
const SILENCE_DURATION_BEFORE_RELEASE_MS = 1000;

/** Minimum speech (ms) required before a silence window can trigger release. */
const MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS = 120;

// ---------------------------------------------------------------------------
// Reconnect (hands-free only)
// ---------------------------------------------------------------------------

// Retryable close codes (velay 1012/1013) are defined by the transport
// (RETRYABLE_LIVE_VOICE_CLOSE_CODES) and shared here so the transport's
// pre-`ready` handling and this controller's reconnect gate stay in lockstep.

/**
 * Backoff before each hands-free reconnect attempt. The first delay clears the
 * gateway's velay-tunnel re-registration window (~0.8s observed) so the retry
 * doesn't race ahead of the tunnel and fail pre-`ready`; later attempts back
 * off to ride out a longer outage. The array length caps the number of
 * attempts — after the last one the session fails.
 */
const RECONNECT_BACKOFF_MS = [1200, 3000, 6000];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UseLiveVoiceResult {
  /** Current session phase. */
  state: LiveVoiceSessionState;
  /** In-flight partial user transcript. Pinned at `""` when the consumer opted out via {@link UseLiveVoiceOptions.observeAudioState}. */
  partialTranscript: string;
  /** Last finalized user transcript. Pinned at `""` when `observeAudioState` is false. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. Pinned at `""` when `observeAudioState` is false. */
  assistantTranscript: string;
  /** Smoothed mic amplitude in [0, 1]. Pinned at `0` when `observeAudioState` is false. */
  inputAmplitude: number;
  /** Failure message when `state === "failed"`, else `null`. */
  error: string | null;
  /** Start a session for `assistantId`, optionally attaching a conversation. */
  start: (
    assistantId: string,
    conversationId?: string,
    options?: LiveVoiceStartOptions,
  ) => Promise<void>;
  /** End the session and release the mic, socket, and audio context. */
  stop: () => Promise<void>;
}

/** Per-session options for {@link UseLiveVoiceResult.start}. */
export interface LiveVoiceStartOptions {
  /**
   * Hands-free mode: connect with server-side turn detection (`server_vad`),
   * forward mic audio for the whole session, and run multiple turns on one
   * socket. Defaults to the legacy per-turn push-to-talk flow.
   */
  handsFree?: boolean;
}

/** Injectable factories so tests can supply mock primitives. */
export interface UseLiveVoiceOptions {
  createClient?: () => LiveVoiceChannelClient;
  createCapture?: (
    options: ConstructorParameters<typeof LiveVoiceAudioCapture>[0],
  ) => LiveVoiceAudioCapture;
  createPlayer?: () => LiveVoiceAudioPlayer;
  /**
   * When `false`, this hook instance does not subscribe to the high-frequency
   * audio/transcript store fields — `inputAmplitude` (updated on every mic
   * amplitude sample), `partialTranscript`, `finalTranscript`, and
   * `assistantTranscript` — so those updates never re-render the consumer. The
   * corresponding returned fields are pinned at their idle defaults (`0` /
   * `""`); read them via `useLiveVoiceStore` (selectors or `getState()`)
   * instead. The low-frequency `state`/`error` fields and the actions are
   * unaffected.
   *
   * For consumers that only need the session phase + actions — e.g. the
   * composer, whose voice bar polls amplitude with `getState()` inside its
   * canvas draw loop. Must be stable for the lifetime of the hook instance.
   * Defaults to `true` (subscribe to everything, the original behavior).
   */
  observeAudioState?: boolean;
  /**
   * Override the hands-free reconnect backoff schedule (ms per attempt; length
   * caps the attempt count). Primarily a test seam so specs don't wait real
   * seconds; production uses {@link RECONNECT_BACKOFF_MS}.
   */
  reconnectBackoffMs?: number[];
}

/**
 * Mutable per-session bookkeeping that must not trigger re-renders. Lives in a
 * ref alongside the active primitives; replaced wholesale on each `start()`.
 */
interface SessionContext {
  /** Assistant the session is bound to; reused verbatim on reconnect. */
  assistantId: string;
  client: LiveVoiceChannelClient;
  capture: LiveVoiceAudioCapture;
  player: LiveVoiceAudioPlayer;
  /** Unsubscribe callbacks for the client event handlers. */
  unsubscribes: Array<() => void>;
  /** Monotonic id; a stale callback whose generation differs is ignored. */
  generation: number;
  /**
   * Hands-free (server-VAD) session: forwarding stays on for the whole session,
   * the server owns utterance boundaries/barge-in, and `tts_done` cycles back
   * to `listening` instead of tearing down.
   */
  handsFree: boolean;
  /** Whether the mic capture graph is running (open for the whole session). */
  captureRunning: boolean;
  /**
   * Whether captured PCM is currently streamed to the server. In hands-free
   * mode it stays on for the entire session (full duplex). In manual mode it is
   * on while the user is speaking (`listening`) and turned off after an
   * automatic push-to-talk release; a manual session is single-utterance (the
   * runtime treats `ptt_release` as terminal — it never re-accepts audio), so
   * forwarding is not re-opened within a session: the session ends after the
   * response, and a fresh session is started for the next turn. Amplitude keeps
   * flowing regardless so barge-in works while not forwarding.
   */
  forwardingAudio: boolean;
  /** Whether the assistant has sent any TTS audio for the current response. */
  responseAudioStarted: boolean;
  /**
   * Monotonic counter bumped on every transition into `thinking` (server
   * frame, or hands-free stt-final); identifies which response owns the state.
   */
  responseEpoch: number;
  /** Whether an interrupt was already sent for the current response. */
  interruptSent: boolean;
  /** Whether an automatic ptt_release is already in flight for this utterance. */
  releaseInFlight: boolean;
  /** Accumulated speech duration (ms) in the current utterance. */
  speechMs: number;
  /** Accumulated trailing silence (ms) after speech in the current utterance. */
  silenceMs: number;
}

/** Number of bytes per Int16 PCM sample. */
const BYTES_PER_SAMPLE = 2;

/** Milliseconds of audio represented by a captured PCM chunk. */
function chunkDurationMs(buf: ArrayBuffer): number {
  const sampleCount = buf.byteLength / BYTES_PER_SAMPLE;
  return (sampleCount / LIVE_VOICE_AUDIO_FORMAT.sampleRate) * 1000;
}

export function useLiveVoice(
  options: UseLiveVoiceOptions = {},
): UseLiveVoiceResult {
  const observeAudioState = options.observeAudioState ?? true;
  const state = useLiveVoiceStore.use.state();
  // High-frequency / transcript fields are read through conditional selectors:
  // when the consumer opted out, the selector returns the idle default, so the
  // subscription exists but never produces a changed value — i.e. amplitude
  // ticks and transcript deltas cannot re-render the consumer.
  const partialTranscript = useLiveVoiceStore((s) =>
    observeAudioState ? s.partialTranscript : "",
  );
  const finalTranscript = useLiveVoiceStore((s) =>
    observeAudioState ? s.finalTranscript : "",
  );
  const assistantTranscript = useLiveVoiceStore((s) =>
    observeAudioState ? s.assistantTranscript : "",
  );
  const inputAmplitude = useLiveVoiceStore((s) =>
    observeAudioState ? s.inputAmplitude : 0,
  );
  const error = useLiveVoiceStore.use.error();

  const sessionRef = useRef<SessionContext | null>(null);

  // Monotonic count of `start()` calls for this hook instance. `stop()`
  // captures it before its awaits and skips its trailing store reset when a
  // newer session started in the meantime — the per-session `generation`
  // can't cover this because `stop()` nulls `sessionRef` synchronously, so
  // the racing session is a different context object entirely.
  //
  // Considered and rejected: guarding the trailing reset with
  // `if (sessionRef.current !== null)` instead. That is behaviorally
  // equivalent *today* only because `start()` assigns `sessionRef`
  // synchronously; a refactor that introduces an await before that
  // assignment would silently reopen the race — the null-check would see no
  // session yet and wrongly reset the newer session's store state. The
  // counter increments synchronously at `start()`'s entry, so it stays
  // correct regardless of where awaits land later.
  const startGenerationRef = useRef(0);

  // Keep the factories in a ref so start()/stop() stay stable across renders
  // even if callers pass inline option objects. The ref is updated in an effect
  // (not during render) to satisfy the react-compiler "no refs during render"
  // rule; `start()` only reads it on user action, well after mount.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Hands-free reconnect bookkeeping. `reconnectAttemptRef` counts consecutive
  // retryable-close reconnects (reset to 0 on a fresh `start()` and on every
  // `ready`); `reconnectTimerRef` holds the pending backoff timer so stop()/
  // teardown()/unmount can cancel an in-flight reconnect. `connectSessionRef`
  // lets the transport `closed` handler re-enter the connect flow without a
  // useCallback self-reference cycle.
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectSessionRef = useRef<
    | ((
        assistantId: string,
        conversationId: string | undefined,
        startOptions: LiveVoiceStartOptions,
      ) => Promise<void>)
    | null
  >(null);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Tear down the active session's primitives, clear the ref, and reset the
   * store to idle.
   *
   * Resetting here keeps the store from getting stuck non-idle when the
   * consumer unmounts mid-session (otherwise the composer would permanently
   * disable dictation and keep the transcript surface mounted). Callers that
   * need a terminal state other than `idle` (e.g. `finishWithError` → `failed`)
   * set it *after* calling `teardown()`, so the reset can't clobber it.
   */
  const teardown = useCallback(() => {
    // Cancel any pending hands-free reconnect first — teardown is terminal, so
    // a queued reconnect must not resurrect the session behind idle UI.
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    const session = sessionRef.current;
    if (!session) {
      // During the reconnect backoff gap `sessionRef` is null while the store
      // still shows an active (`connecting`) session with live controls. An
      // unmount here (its cleanup calls teardown) must still reset the store,
      // or it strands non-idle with stale controls — dictation stays disabled
      // and a phantom session lingers after navigation. Guard on non-idle so a
      // teardown with nothing to do doesn't churn the store.
      if (useLiveVoiceStore.getState().state !== "idle") {
        useLiveVoiceStore.getState().reset();
      }
      return;
    }
    sessionRef.current = null;
    disposeSessionPrimitives(session);
    useLiveVoiceStore.getState().reset();
  }, [clearReconnectTimer]);

  const stop = useCallback(async () => {
    // A user-initiated stop ends the session outright — drop any pending
    // reconnect and its attempt budget.
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    const session = sessionRef.current;
    if (!session) {
      useLiveVoiceStore.getState().reset();
      return;
    }
    const startGeneration = startGenerationRef.current;
    sessionRef.current = null;
    session.generation += 1;
    useLiveVoiceStore.getState().setState("ending");
    for (const unsubscribe of session.unsubscribes) unsubscribe();
    session.unsubscribes = [];
    session.client.end();
    // Release the AudioContext, not just the scheduled sources (see teardown).
    await session.player.dispose();
    await session.capture.shutdown();
    // A start() that raced the awaits owns the store now (e.g. a second ✕
    // click resets `ending` → idle mid-await, unblocking start()); wiping it
    // here would leave that session's mic hot behind idle UI.
    if (startGenerationRef.current !== startGeneration) return;
    useLiveVoiceStore.getState().reset();
  }, [clearReconnectTimer]);

  /**
   * Manual push-to-talk release — same internal path as the automatic silence
   * release. Guarded to `listening` so a stray click (or the store-registered
   * control firing late) can't disturb another phase.
   */
  const release = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    // Hands-free sessions have no manual push-to-talk to release: the server
    // VAD owns utterance boundaries and mic forwarding stays on for the whole
    // session. A release here would flip `forwardingAudio` off — which the
    // hands-free `tts_done`/listening return never re-enables — so every later
    // mic chunk is dropped and the session strands (looks live, accepts no
    // turns). No-op instead; the "send now" affordance is manual-mode only.
    if (session.handsFree) return;
    if (useLiveVoiceStore.getState().state !== "listening") return;
    releasePushToTalk(session);
  }, []);

  /**
   * Stop in-flight assistant playback — the barge-in interrupt path without
   * the amplitude gate. `interruptIfSpeaking` itself guards to `speaking`.
   */
  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    interruptIfSpeaking(session, teardown);
  }, [teardown]);

  // The connect flow, shared by the user-facing `start()` and the hands-free
  // reconnect path. `start()` owns the "already active" guard and resets the
  // reconnect budget; `connectSession` assumes it may run. On reconnect it is
  // invoked with the authoritative conversation id so the fresh session
  // re-attaches to the same conversation.
  const connectSession = useCallback(
    async (
      assistantId: string,
      conversationId: string | undefined,
      startOptions: LiveVoiceStartOptions,
    ) => {
      if (sessionRef.current) teardown();
      startGenerationRef.current += 1;

      const store = useLiveVoiceStore.getState();
      store.reset();
      store.setState("connecting");
      // A retry re-enters here via the backoff timer with `reconnectAttemptRef`
      // already bumped (> 0) by the transport `closed` handler, so relabel the
      // connect as a reconnect; a fresh `start()` (attempt 0) clears it. The
      // `store.reset()` above already cleared `reconnecting`, so this only needs
      // to (re)assert true on the reconnect path.
      store.setReconnecting(reconnectAttemptRef.current > 0);
      store.setSessionContext(assistantId, conversationId ?? null);
      // Registered here (not on `ready`) so a globally mounted surface can
      // drive the session from the moment it exists; cleared by the store
      // reset in teardown()/stop().
      store.setControls({ stop: () => void stop(), release, interrupt });

      const opts = optionsRef.current;
      const client = (opts.createClient ?? (() => new LiveVoiceChannelClient()))();
      const player = (opts.createPlayer ?? (() => new LiveVoiceAudioPlayer()))();
      // Resume the playback AudioContext now, while we're still in the
      // mic-button click's gesture. Deferring to the first `tts_audio` frame
      // (its lazy creation point) lands outside any gesture, so the browser
      // starts it suspended and the first turn's audio is silently dropped.
      player.prewarm();

      const session: SessionContext = {
        assistantId,
        client,
        capture: undefined as unknown as LiveVoiceAudioCapture,
        player,
        unsubscribes: [],
        generation: 0,
        handsFree: startOptions.handsFree === true,
        captureRunning: false,
        forwardingAudio: false,
        responseAudioStarted: false,
        responseEpoch: 0,
        interruptSent: false,
        releaseInFlight: false,
        speechMs: 0,
        silenceMs: 0,
      };

      const capture = (opts.createCapture ?? ((o) => new LiveVoiceAudioCapture(o)))({
        onChunk: (buf) => handleChunk(session, buf),
        onAmplitude: (amplitude) => handleAmplitude(session, amplitude, teardown),
      });
      session.capture = capture;
      sessionRef.current = session;

      const generation = session.generation;
      const live = () =>
        sessionRef.current === session && session.generation === generation;

      session.unsubscribes.push(
        client.on("ready", (frame) => {
          if (!live()) return;
          // Version skew: an older daemon ignores the start frame's
          // turnDetection and runs a manual session without echoing the mode.
          // Fall back to manual behavior (auto-release, amplitude barge-in,
          // single-turn teardown) so the session works instead of hanging.
          if (session.handsFree && frame.turnDetection !== "server_vad") {
            session.handsFree = false;
          }
          // A `ready` means the (re)connection succeeded — clear the reconnect
          // budget so a later, unrelated tunnel drop gets its full retry set,
          // and drop the reconnect label so the surface stops showing a retry.
          reconnectAttemptRef.current = 0;
          useLiveVoiceStore.getState().setReconnecting(false);
          // When started from a new/empty conversation, `conversationId` was
          // undefined at start() and the store published `null`. The server
          // assigns (or confirms) the attached conversation on `ready`, so
          // republish the authoritative id. `setConversationId` (not
          // `setSessionContext`) so `startedConversationId` keeps its
          // start-time value — session ownership for a draft-started session
          // hinges on it (see `isLiveVoiceSessionOwnedBy`).
          useLiveVoiceStore.getState().setConversationId(frame.conversationId);
          void startCapture(session, teardown);
        }),
        client.on("speechStarted", () => {
          if (!live() || !session.handsFree) return;
          // Server VAD heard the user: flush tail playback unconditionally
          // (even mid-`thinking`, when no cancellation follows) and open the
          // next utterance.
          useLiveVoiceStore.getState().clearUserTranscripts();
          flushPlaybackToListening(session);
        }),
        client.on("utteranceEnd", () => {
          if (!live() || !session.handsFree) return;
          // Server VAD closed the utterance; its transcription is finishing.
          useLiveVoiceStore.getState().setState("transcribing");
        }),
        client.on("utteranceDiscarded", () => {
          if (!live() || !session.handsFree) return;
          // The closed utterance had no usable speech (noise/cough); return
          // to listening. A discarded utterance never reaches `thinking`
          // (empty finals stay in `transcribing`), so any other state belongs
          // to a newer turn and is left alone.
          const s = useLiveVoiceStore.getState();
          if (s.state === "transcribing") s.setState("listening");
        }),
        client.on("sttPartial", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setPartialTranscript(frame.text);
          // Manual mode: only while still forwarding (the user's turn) does a
          // partial keep us in `listening`; after ptt-release we're
          // transcribing/thinking. Hands-free transitions are frame-driven
          // (`speech_started`/`utterance_end`), so partials never move state.
          if (!session.handsFree && session.forwardingAudio) {
            s.setState("listening");
          }
        }),
        client.on("sttFinal", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setFinalTranscript(frame.text);
          s.setPartialTranscript("");
          // Hands-free: `utterance_end` already closed the utterance, so a
          // final means the server is about to think. Manual mode: forwarding ⇒
          // the user is still speaking (stay listening); otherwise ptt was
          // released and the server is about to think.
          if (!session.handsFree && session.forwardingAudio) {
            s.setState("listening");
            return;
          }
          if (session.handsFree) {
            // An empty final never starts a server turn (the utterance will
            // be discarded); stay in `transcribing` so `utterance_discarded`
            // can safely return to `listening` without racing a real turn.
            if (frame.text.trim().length === 0) return;
            // The next turn now owns the state: a prior turn's drain waiter
            // must not reset it to `listening` if it resolves before the
            // server's `thinking` frame (which re-bumps; the guard only
            // checks inequality, so the double bump is harmless).
            session.responseEpoch += 1;
          }
          s.setState("thinking");
        }),
        client.on("thinking", () => {
          if (!live()) return;
          // New response: reset the per-response transcript and barge-in flags.
          session.responseEpoch += 1;
          session.responseAudioStarted = false;
          session.interruptSent = false;
          const s = useLiveVoiceStore.getState();
          s.clearAssistantTranscript();
          s.setState("thinking");
        }),
        client.on("assistantTextDelta", (frame) => {
          if (!live() || frame.text.length === 0) return;
          const s = useLiveVoiceStore.getState();
          s.appendAssistantTranscript(frame.text);
          const phase = s.state;
          if (phase === "listening" || phase === "transcribing") {
            s.setState("thinking");
          }
        }),
        client.on("ttsAudio", (frame) => {
          if (!live()) return;
          beginAssistantAudioIfNeeded(session);
          const chunk: TtsAudioChunk = {
            dataBase64: frame.dataBase64,
            sampleRate: frame.sampleRate,
            mimeType: frame.mimeType,
          };
          session.player.enqueue(chunk);
          useLiveVoiceStore.getState().setState("speaking");
        }),
        client.on("ttsDone", () => {
          if (!live()) return;
          void finishResponseAfterPlayback(session, teardown);
        }),
        client.on("turnCancelled", () => {
          if (!live() || !session.handsFree) return;
          // Barge-in aborted the turn; no tts_done follows a cancelled turn.
          flushPlaybackToListening(session);
        }),
        client.on("archived", () => {
          if (!live()) return;
          // Persisted; nothing user-visible to do here.
        }),
        client.on("busy", () => {
          if (!live()) return;
          finishWithError(session, teardown, "Another live-voice session is active.");
        }),
        client.on("error", (err: LiveVoiceClientError) => {
          if (!live()) return;
          // Hands-free: a recoverable error (transient transcriber blip,
          // one failed TTS segment) must not kill the conversation. Resume
          // listening unless a turn is mid-flight; the transport stayed open.
          if (session.handsFree && err.recoverable === true) {
            console.warn(`live-voice: recoverable error: ${err.message}`);
            const s = useLiveVoiceStore.getState();
            if (s.state === "transcribing") s.setState("listening");
            return;
          }
          finishWithError(session, teardown, err.message);
        }),
        client.on("closed", (info) => {
          // A transport close after a clean end()/teardown is expected; only an
          // unexpected close while still attached needs cleanup.
          if (!live()) return;
          // Hands-free resilience: velay tears down a proxied session with a
          // retryable close code (1013 "assistant tunnel disconnected") when
          // its tunnel to the assistant drops mid-conversation (deploy, key
          // rotation, network blip). The runtime session is gone, but the
          // conversation persists — so reconnect a fresh session to the same
          // conversation instead of silently ending (which reads to the user
          // as an unexplained cancel). Bounded by the backoff table; a manual
          // (non-server_vad) session and a locally-initiated close never retry.
          const backoff =
            optionsRef.current.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
          if (
            session.handsFree &&
            info.code !== null &&
            RETRYABLE_LIVE_VOICE_CLOSE_CODES.has(info.code) &&
            reconnectAttemptRef.current < backoff.length
          ) {
            const attempt = reconnectAttemptRef.current;
            reconnectAttemptRef.current = attempt + 1;
            const delayMs = backoff[attempt] ?? 0;
            // The server-assigned conversation id (republished on `ready`) so
            // the fresh session resumes the same conversation.
            const store = useLiveVoiceStore.getState();
            const conversationId =
              store.conversationId ?? store.startedConversationId ?? undefined;
            const assistantId = session.assistantId;
            // Drop the dead primitives but hold the UI in `connecting` (not
            // idle) with a live stop control, so the surface shows a
            // reconnect rather than a vanished session and the user can still
            // bail during the gap.
            sessionRef.current = null;
            disposeSessionPrimitives(session);
            const s = useLiveVoiceStore.getState();
            s.setState("connecting");
            // Hold the reconnect label through the backoff gap (before the
            // timer re-enters `connectSession`) so the surface shows a
            // reconnect, not a fresh connect. Cleared on `ready`/teardown.
            s.setReconnecting(true);
            s.setControls({ stop: () => void stop(), release, interrupt });
            console.warn(
              `live-voice: transport closed (code ${info.code}); reconnecting ` +
                `(attempt ${attempt + 1}/${backoff.length})`,
            );
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              void connectSessionRef.current?.(assistantId, conversationId, {
                handsFree: true,
              });
            }, delayMs);
            return;
          }
          // Non-retryable (or budget exhausted): tear down to idle.
          teardown();
        }),
      );

      await client.connect({
        assistantId,
        conversationId,
        ...(session.handsFree ? { turnDetection: "server_vad" as const } : {}),
      });
    },
    [teardown, stop, release, interrupt],
  );

  // Let the transport `closed` handler re-enter the connect flow for a
  // reconnect without a useCallback self-reference cycle. Updated in an effect
  // (not during render) per the react-compiler "no refs during render" rule;
  // the handler only reads it after a backoff timer, well after this commits.
  useEffect(() => {
    connectSessionRef.current = connectSession;
  }, [connectSession]);

  const start = useCallback(
    async (
      assistantId: string,
      conversationId?: string,
      startOptions?: LiveVoiceStartOptions,
    ) => {
      // A live session (anything but idle/failed) blocks a new start. Keyed
      // on the store phase alone — NOT on `sessionRef` — because during
      // `ending` stop() has already nulled the ref while its async teardown
      // is still in flight; a start() admitted in that window would be wiped
      // by stop()'s trailing reset (hot mic behind idle UI). `connecting`
      // also covers an in-flight reconnect, so a mic click during the backoff
      // gap doesn't spawn a second session.
      if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) return;
      // Fresh user-initiated session: drop any stale reconnect budget/timer.
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      await connectSession(assistantId, conversationId, startOptions ?? {});
    },
    [connectSession, clearReconnectTimer],
  );

  // Release everything if the consumer unmounts mid-session. teardown() also
  // resets the store to idle so a mid-session unmount doesn't strand it in a
  // non-idle phase (which would keep dictation disabled via the composer) and
  // cancels any pending reconnect so it can't fire after unmount.
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    inputAmplitude,
    error,
    start,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Session helpers (operate on the session context; never re-render directly)
// ---------------------------------------------------------------------------

/**
 * Release a session's primitives (event subscriptions, socket, playback
 * AudioContext, mic capture) and bump its generation so any in-flight async
 * callbacks become stale no-ops. Does NOT touch the store — callers set the
 * next store phase themselves (`teardown()` → idle; the reconnect path →
 * `connecting`). `dispose()` (not a bare `stop()`) releases the AudioContext,
 * which a bare stop would leak across sessions until page unload.
 */
function disposeSessionPrimitives(session: SessionContext): void {
  session.generation += 1;
  for (const unsubscribe of session.unsubscribes) unsubscribe();
  session.unsubscribes = [];
  session.client.close();
  void session.player.dispose();
  void session.capture.shutdown();
}

/** Open the mic and begin streaming PCM. Failure transitions to `failed`. */
async function startCapture(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  const result = await session.capture.start();
  // A stop()/teardown that raced our await replaced or advanced the session.
  if (session.generation !== generation) {
    if (result.ok) void session.capture.stop();
    return;
  }
  if (!result.ok) {
    finishWithError(session, teardown, "Microphone capture could not start.");
    return;
  }
  session.captureRunning = true;
  session.forwardingAudio = true;
  const s = useLiveVoiceStore.getState();
  if (s.state === "connecting") s.setState("listening");
}

/**
 * Forward a captured PCM chunk to the server and drive silence detection.
 *
 * The mic stays open across the whole session, but PCM is only streamed while
 * `forwardingAudio` is on (always, in hands-free mode; during the user's turn
 * in manual mode). Client-local silence detection is manual-mode only — in
 * hands-free the server VAD owns utterance boundaries.
 */
function handleChunk(session: SessionContext, buf: ArrayBuffer): void {
  if (!session.captureRunning || !session.forwardingAudio) return;
  session.client.sendAudio(buf);
  if (!session.handsFree) {
    updateAutomaticRelease(session, buf);
  }
}

/**
 * Apply the latest amplitude to the store and run barge-in detection.
 *
 * Runs whenever the mic is open — including while not forwarding — so a loud
 * amplitude can interrupt the assistant mid-response (barge-in). Amplitude
 * barge-in is manual-mode only: in hands-free the server VAD detects speech
 * over the forwarded audio and drives barge-in via `speech_started` /
 * `turn_cancelled`.
 */
function handleAmplitude(
  session: SessionContext,
  amplitude: number,
  teardown: () => void,
): void {
  if (!session.captureRunning) return;
  useLiveVoiceStore.getState().setInputAmplitude(amplitude);
  if (!session.handsFree && amplitude >= BARGE_IN_AMPLITUDE_THRESHOLD) {
    interruptIfSpeaking(session, teardown);
  }
}

/**
 * Track speech / trailing-silence durations and auto-release push-to-talk once
 * a real utterance is followed by a long-enough silence window.
 */
function updateAutomaticRelease(session: SessionContext, buf: ArrayBuffer): void {
  if (useLiveVoiceStore.getState().state !== "listening") return;
  const durationMs = chunkDurationMs(buf);
  if (durationMs <= 0) return;

  // The amplitude for this chunk was applied via onAmplitude; read it back so
  // chunk-level speech/silence classification stays in sync with the UI value.
  const amplitude = useLiveVoiceStore.getState().inputAmplitude;
  if (amplitude >= SPEECH_AMPLITUDE_THRESHOLD) {
    session.speechMs += durationMs;
    session.silenceMs = 0;
    return;
  }
  if (session.speechMs < MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS) {
    session.speechMs = 0;
    return;
  }
  session.silenceMs += durationMs;
  if (session.silenceMs < SILENCE_DURATION_BEFORE_RELEASE_MS) return;
  releasePushToTalk(session);
}

/**
 * Stop *forwarding* audio and release push-to-talk; moves to `transcribing`.
 *
 * The mic capture graph keeps running (so amplitude continues to flow for
 * barge-in); only the per-turn forwarding gate is closed here.
 */
function releasePushToTalk(session: SessionContext): void {
  if (session.releaseInFlight || !session.forwardingAudio) return;
  session.releaseInFlight = true;
  session.forwardingAudio = false;
  session.client.pttRelease();
  const s = useLiveVoiceStore.getState();
  if (s.state === "listening") s.setState("transcribing");
  s.setInputAmplitude(0);
}

/**
 * Barge-in: stop playback and interrupt the server once per response, then end
 * the session (→ idle). The interrupted session is terminal on the runtime — it
 * won't accept more audio — so we can't keep forwarding on it; the user starts a
 * fresh session to respond. (Seamless reconnect-on-barge-in is a follow-up.)
 */
function interruptIfSpeaking(
  session: SessionContext,
  teardown: () => void,
): void {
  if (useLiveVoiceStore.getState().state !== "speaking") return;
  if (!session.player.isPlaying || session.interruptSent) return;
  session.interruptSent = true;
  session.player.stop();
  session.client.interrupt();
  teardown();
}

/** First TTS frame of a response: reset playback flags for the new utterance. */
function beginAssistantAudioIfNeeded(session: SessionContext): void {
  if (session.responseAudioStarted) return;
  session.responseAudioStarted = true;
  session.interruptSent = false;
}

/**
 * Hands-free: flush local TTS playback immediately, drop expectations for the
 * in-flight response, and keep the session live in `listening`.
 */
function flushPlaybackToListening(session: SessionContext): void {
  session.player.stop();
  session.responseAudioStarted = false;
  useLiveVoiceStore.getState().setState("listening");
}

/**
 * After `tts_done`, await playback drain, then finish the turn.
 *
 * Hands-free: the session is multi-turn, so the turn's end is not the
 * session's — forwarding stays on and the session returns to `listening` on
 * the same socket. A `speech_started`/`turn_cancelled` during the drain
 * already flushed playback and moved the state onward, so only a
 * still-completing turn (`speaking`, or `thinking` when the turn produced no
 * audio) cycles back to `listening`. A *newer* turn's `thinking` arriving
 * mid-drain bumps `responseEpoch`; that turn owns the state, so the post-drain
 * transition is skipped rather than clobbering it back to `listening`.
 *
 * Manual mode: the session is single-utterance — once `ptt_release` fires the
 * runtime won't accept more audio on it, so we don't resume listening on the
 * same socket — we tear the session down and the user starts a fresh one for
 * the next turn (mirrors the macOS `closeCompletedUtteranceSessionAfterPlayback`).
 * Forwarding is suspended during the drain so playback audio captured by the
 * (still-open) mic isn't streamed back. A barge-in during the drain already
 * tore this session down and reconnected (generation bumped / state no longer
 * `speaking`), so we leave that fresh session alone.
 */
async function finishResponseAfterPlayback(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  const responseEpoch = session.responseEpoch;
  session.responseAudioStarted = false;
  if (!session.handsFree) {
    session.forwardingAudio = false;
  }

  await session.player.waitUntilDrained();
  if (session.generation !== generation) return;

  const state = useLiveVoiceStore.getState().state;
  if (session.handsFree) {
    // A newer turn started while audio drained; leave its state alone.
    if (session.responseEpoch !== responseEpoch) return;
    if (state === "speaking" || state === "thinking") {
      useLiveVoiceStore.getState().setState("listening");
    }
    return;
  }

  // A barge-in mid-drain already reconnected a fresh session; don't tear it down.
  if (state !== "speaking") return;
  teardown();
}

/** Fail the session: tear down primitives and surface the message. */
function finishWithError(
  session: SessionContext,
  teardown: () => void,
  message: string,
): void {
  teardown();
  useLiveVoiceStore.getState().fail(message);
}
