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
 * ## Multi-turn sessions
 * One session spans many turns over a single socket and a single mic
 * acquisition: after the assistant's response finishes playing (or is
 * interrupted), the controller re-opens audio forwarding and returns to
 * `listening` for the next utterance. The session ends via `stop()` (user), a
 * server `session_ended` (goodbye plays out, then teardown), a server/socket
 * `closed`, `busy`, or an error.
 *
 * ## State transitions
 * `idle → connecting` (start) → `listening` (ready + capture started) →
 * `transcribing` (ptt released / server turn boundary) → `thinking` (server
 * response) → `speaking` (tts_audio) → `listening` (tts_done drained, or
 * barge-in confirmed via `interrupted`) → … repeating until `stop()`, an
 * error, or a server `closed` returns to `idle`/`failed`.
 *
 * ## Mic forwarding
 * The mic capture graph runs for the entire active session so amplitude keeps
 * flowing for barge-in even while the assistant is thinking/speaking. Audio
 * *forwarding* (`session.forwardingAudio`) is gated to the user's turn: captured
 * PCM is streamed only while forwarding is on. Push-to-talk release flips
 * forwarding off (without stopping the mic); resuming listening for the next
 * turn re-opens it.
 *
 * ## Barge-in
 * While `speaking`, a captured amplitude over {@link BARGE_IN_AMPLITUDE_THRESHOLD}
 * stops playback and sends `interrupt` (once per response). The server confirms
 * with an `interrupted` frame — which also arrives unprompted on server-VAD
 * barge-in — flushing playback and resuming `listening` on the same socket.
 *
 * ## Automatic push-to-talk release
 * While `listening`, sustained speech (≥ {@link MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS})
 * followed by {@link SILENCE_DURATION_BEFORE_RELEASE_MS} of silence releases
 * push-to-talk and moves to `transcribing` (mic stays open).
 */

import { useCallback, useEffect, useRef } from "react";

import {
  LiveVoiceChannelClient,
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
import type { LiveVoiceSessionMode } from "@/domains/chat/voice/live-voice/protocol";

// ---------------------------------------------------------------------------
// Client-side amplitude/timing thresholds
// ---------------------------------------------------------------------------

/** Mic amplitude (in [0, 1]) above which barge-in interrupts assistant speech. */
const BARGE_IN_AMPLITUDE_THRESHOLD = 0.05;

/** Mic amplitude above which a chunk counts as speech (for silence detection). */
const SPEECH_AMPLITUDE_THRESHOLD = 0.03;

/** Trailing silence (ms) after speech that triggers an automatic ptt_release. */
const SILENCE_DURATION_BEFORE_RELEASE_MS = 1000;

/** Minimum speech (ms) required before a silence window can trigger release. */
const MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS = 120;

/**
 * Backstop for a turn the server never picked up: if the session sits in
 * `transcribing`/`thinking` this long with no server progress *before* a
 * `thinking` frame confirmed the turn, resume listening so a silently
 * dropped turn can't strand the client. Once `thinking` arrives the
 * backstop disarms for the rest of the turn — the server owns the turn's
 * failure modes from there (`turn_cancelled` with a reason, or a fatal
 * `error`), and long tool-using turns legitimately emit nothing between
 * `thinking` and the first delta.
 */
const STUCK_TURN_TIMEOUT_MS = 15_000;

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
  /**
   * Machine reason from the last server `turn_cancelled` frame (e.g.
   * `empty_transcript`, `stt_failed`, `tts_failed`). Non-fatal — the
   * session resumed listening. Cleared when the next turn is accepted.
   */
  turnCancelledReason: string | null;
  /** Failure message when `state === "failed"`, else `null`. */
  error: string | null;
  /**
   * Start a session for `assistantId`, optionally attaching a conversation
   * and requesting a session mode (default: server-side PTT).
   */
  start: (
    assistantId: string,
    conversationId?: string,
    mode?: LiveVoiceSessionMode,
  ) => Promise<void>;
  /** End the session and release the mic, socket, and audio context. */
  stop: () => Promise<void>;
}

/** Injectable factories so tests can supply mock primitives. */
export interface UseLiveVoiceOptions {
  createClient?: () => LiveVoiceChannelClient;
  createCapture?: (
    options: ConstructorParameters<typeof LiveVoiceAudioCapture>[0],
  ) => LiveVoiceAudioCapture;
  createPlayer?: () => LiveVoiceAudioPlayer;
  /** Override the stuck-turn backstop timeout (tests). */
  stuckTurnTimeoutMs?: number;
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
}

/**
 * Mutable per-session bookkeeping that must not trigger re-renders. Lives in a
 * ref alongside the active primitives; replaced wholesale on each `start()`.
 */
interface SessionContext {
  client: LiveVoiceChannelClient;
  capture: LiveVoiceAudioCapture;
  player: LiveVoiceAudioPlayer;
  /** Unsubscribe callbacks for the client event handlers. */
  unsubscribes: Array<() => void>;
  /** Monotonic id; a stale callback whose generation differs is ignored. */
  generation: number;
  /** Whether the mic capture graph is running (open for the whole session). */
  captureRunning: boolean;
  /**
   * Whether captured PCM is currently streamed to the server. On while the user
   * is speaking (`listening`); turned off by push-to-talk release and while the
   * assistant response plays, then re-opened by {@link resumeListening} for the
   * next turn. Amplitude keeps flowing regardless so barge-in works while not
   * forwarding.
   */
  forwardingAudio: boolean;
  /** Whether the assistant has sent any TTS audio for the current response. */
  responseAudioStarted: boolean;
  /** Whether an interrupt was already sent for the current response. */
  interruptSent: boolean;
  /** Whether an automatic ptt_release is already in flight for this utterance. */
  releaseInFlight: boolean;
  /** Accumulated speech duration (ms) in the current utterance. */
  speechMs: number;
  /** Accumulated trailing silence (ms) after speech in the current utterance. */
  silenceMs: number;
  /**
   * Set when the server announced `session_ended`; the drain-then-teardown
   * path owns cleanup, so the socket `closed` that follows must not tear
   * down mid-goodbye.
   */
  serverEnded: boolean;
  /**
   * Set when a `thinking` frame (or an assistant delta) confirms the server
   * accepted the current turn; disarms the stuck-turn backstop until the
   * next turn starts listening.
   */
  serverAcceptedTurn: boolean;
  /** Stuck-turn backstop timer (armed while awaiting turn acceptance). */
  turnBackstopTimer: ReturnType<typeof setTimeout> | null;
  /** Backstop timeout (injectable for tests). */
  stuckTurnTimeoutMs: number;
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
  const turnCancelledReason = useLiveVoiceStore.use.turnCancelledReason();
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
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    // Bump the generation so any in-flight async callbacks become stale no-ops.
    session.generation += 1;
    clearTurnBackstop(session);
    for (const unsubscribe of session.unsubscribes) unsubscribe();
    session.unsubscribes = [];
    session.client.close();
    // dispose() stops playback *and* releases the AudioContext; a bare stop()
    // would leak the context across repeated sessions until page unload.
    void session.player.dispose();
    void session.capture.shutdown();
    useLiveVoiceStore.getState().reset();
  }, []);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      useLiveVoiceStore.getState().reset();
      return;
    }
    const startGeneration = startGenerationRef.current;
    sessionRef.current = null;
    session.generation += 1;
    clearTurnBackstop(session);
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
  }, []);

  /**
   * Manual push-to-talk release — same internal path as the automatic silence
   * release. Guarded to `listening` so a stray click (or the store-registered
   * control firing late) can't disturb another phase.
   */
  const release = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (useLiveVoiceStore.getState().state !== "listening") return;
    releasePushToTalk(session);
  }, []);

  /**
   * Stop in-flight assistant playback — the barge-in interrupt path without
   * the amplitude gate. `interruptIfSpeaking` itself guards to `speaking`.
   * Turn-scoped: the server confirms with `interrupted` and the session
   * resumes `listening` on the same socket.
   */
  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    interruptIfSpeaking(session);
  }, []);

  const start = useCallback(
    async (
      assistantId: string,
      conversationId?: string,
      mode?: LiveVoiceSessionMode,
    ) => {
      // A live session (anything but idle/failed) blocks a new start. Keyed
      // on the store phase alone — NOT on `sessionRef` — because during
      // `ending` stop() has already nulled the ref while its async teardown
      // is still in flight; a start() admitted in that window would be wiped
      // by stop()'s trailing reset (hot mic behind idle UI).
      if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) return;
      if (sessionRef.current) teardown();
      startGenerationRef.current += 1;

      const store = useLiveVoiceStore.getState();
      store.reset();
      store.setState("connecting");
      store.setSessionContext(assistantId, conversationId ?? null);
      // Registered here (not on `ready`) so a globally mounted surface can
      // drive the session from the moment it exists; cleared by the store
      // reset in teardown()/stop().
      store.setControls({ stop: () => void stop(), release, interrupt });

      const opts = optionsRef.current;
      const client = (opts.createClient ?? (() => new LiveVoiceChannelClient()))();
      const player = (opts.createPlayer ?? (() => new LiveVoiceAudioPlayer()))();

      const session: SessionContext = {
        client,
        capture: undefined as unknown as LiveVoiceAudioCapture,
        player,
        unsubscribes: [],
        generation: 0,
        captureRunning: false,
        forwardingAudio: false,
        responseAudioStarted: false,
        interruptSent: false,
        releaseInFlight: false,
        speechMs: 0,
        silenceMs: 0,
        serverEnded: false,
        serverAcceptedTurn: false,
        turnBackstopTimer: null,
        stuckTurnTimeoutMs: opts.stuckTurnTimeoutMs ?? STUCK_TURN_TIMEOUT_MS,
      };

      const capture = (opts.createCapture ?? ((o) => new LiveVoiceAudioCapture(o)))({
        onChunk: (buf) => handleChunk(session, buf),
        onAmplitude: (amplitude) => handleAmplitude(session, amplitude),
      });
      session.capture = capture;
      sessionRef.current = session;

      const generation = session.generation;
      const live = () =>
        sessionRef.current === session && session.generation === generation;

      session.unsubscribes.push(
        client.on("ready", (frame) => {
          if (!live()) return;
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
        client.on("sttPartial", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setPartialTranscript(frame.text);
          // Only while still forwarding (the user's turn) does a partial keep
          // us in `listening`; after ptt-release we're transcribing/thinking.
          if (session.forwardingAudio) s.setState("listening");
          syncTurnBackstop(session);
        }),
        client.on("sttFinal", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setFinalTranscript(frame.text);
          s.setPartialTranscript("");
          // Forwarding ⇒ the user is still speaking (stay listening). After
          // release, a non-empty final means the server is about to think; an
          // empty final produces no assistant turn — hold the current state
          // and wait for `turn_cancelled` (or the stuck-turn backstop).
          if (session.forwardingAudio) {
            s.setState("listening");
          } else if (frame.text.trim().length > 0) {
            s.setState("thinking");
          }
          syncTurnBackstop(session);
        }),
        client.on("thinking", () => {
          if (!live()) return;
          // New response: reset the per-response transcript and barge-in
          // flags. The server has accepted the turn, so the stuck-turn
          // backstop stands down for the rest of it.
          session.serverAcceptedTurn = true;
          session.responseAudioStarted = false;
          session.interruptSent = false;
          const s = useLiveVoiceStore.getState();
          s.setTurnCancelledReason(null);
          s.clearAssistantTranscript();
          s.setState("thinking");
          syncTurnBackstop(session);
        }),
        client.on("assistantTextDelta", (frame) => {
          if (!live() || frame.text.length === 0) return;
          // A delta proves the server is generating this turn's response.
          session.serverAcceptedTurn = true;
          const s = useLiveVoiceStore.getState();
          s.appendAssistantTranscript(frame.text);
          const phase = s.state;
          if (phase === "listening" || phase === "transcribing") {
            s.setState("thinking");
          }
          syncTurnBackstop(session);
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
          syncTurnBackstop(session);
        }),
        client.on("ttsDone", () => {
          if (!live()) return;
          void finishResponseAfterPlayback(session);
        }),
        client.on("turnCancelled", (frame) => {
          if (!live()) return;
          // The server retired the turn without completing a response
          // (empty transcript, or a turn-scoped STT/LLM/TTS failure).
          // Surface the machine reason non-fatally, flush any partial
          // playback (a mid-response TTS failure cancels while audio is
          // already playing), and resume listening instead of waiting for
          // a `tts_done` that will never come.
          const s = useLiveVoiceStore.getState();
          s.setTurnCancelledReason(frame.reason ?? null);
          const phase = s.state;
          if (
            phase === "transcribing" ||
            phase === "thinking" ||
            phase === "speaking"
          ) {
            session.player.stop();
            resumeListening(session);
          }
        }),
        client.on("turnBoundary", () => {
          if (!live()) return;
          // The server segmented the user's turn; close the forwarding gate
          // and mirror the local auto-release UI transition. Under PTT this
          // follows our own ptt_release (gate already closed); in open-mic it
          // is the primary end-of-turn signal — without closing the gate here
          // the client would keep streaming mic (and assistant-playback echo)
          // audio for the rest of the response. No ptt_release is sent: the
          // server owns the boundary.
          session.forwardingAudio = false;
          const s = useLiveVoiceStore.getState();
          if (s.state === "listening") s.setState("transcribing");
          syncTurnBackstop(session);
        }),
        client.on("interrupted", () => {
          if (!live()) return;
          // Barge-in accepted (locally initiated or server-VAD). Flush playback
          // — idempotent when a local barge-in already stopped the player — and
          // go back to listening unless the drain path already resumed.
          session.player.stop();
          if (useLiveVoiceStore.getState().state !== "listening") {
            resumeListening(session);
          }
        }),
        client.on("archived", () => {
          if (!live()) return;
          // Persisted; nothing user-visible to do here.
        }),
        client.on("sessionEnded", () => {
          if (!live()) return;
          // Server-initiated end ([END_CALL] goodbye, max duration): let any
          // buffered goodbye audio finish playing, then tear down to idle.
          session.serverEnded = true;
          void finishSessionAfterServerEnd(session, teardown);
        }),
        client.on("busy", () => {
          if (!live()) return;
          finishWithError(session, teardown, "Another live-voice session is active.");
        }),
        client.on("error", (err: LiveVoiceClientError) => {
          if (!live()) return;
          finishWithError(session, teardown, err.message);
        }),
        client.on("closed", () => {
          // A transport close after a clean end()/teardown is expected; only an
          // unexpected close while still attached needs cleanup. teardown()
          // resets the store to idle. After a server `session_ended` the
          // drain path owns teardown — the close that follows must not cut
          // the goodbye off.
          if (!live()) return;
          if (session.serverEnded) return;
          teardown();
        }),
      );

      await client.connect({
        assistantId,
        conversationId,
        ...(mode ? { mode } : {}),
      });
    },
    [teardown, stop, release, interrupt],
  );

  // Release everything if the consumer unmounts mid-session. teardown() also
  // resets the store to idle so a mid-session unmount doesn't strand it in a
  // non-idle phase (which would keep dictation disabled via the composer).
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    inputAmplitude,
    turnCancelledReason,
    error,
    start,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Session helpers (operate on the session context; never re-render directly)
// ---------------------------------------------------------------------------

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
 * `forwardingAudio` is on (i.e. during the user's turn). Silence detection runs
 * on the same gate so auto-release only fires while we are actually forwarding.
 */
function handleChunk(session: SessionContext, buf: ArrayBuffer): void {
  if (!session.captureRunning || !session.forwardingAudio) return;
  session.client.sendAudio(buf);
  updateAutomaticRelease(session, buf);
}

/**
 * Apply the latest amplitude to the store and run barge-in detection.
 *
 * Runs whenever the mic is open — including while not forwarding — so a loud
 * amplitude can interrupt the assistant mid-response (barge-in).
 */
function handleAmplitude(session: SessionContext, amplitude: number): void {
  if (!session.captureRunning) return;
  useLiveVoiceStore.getState().setInputAmplitude(amplitude);
  if (amplitude >= BARGE_IN_AMPLITUDE_THRESHOLD) {
    interruptIfSpeaking(session);
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
  syncTurnBackstop(session);
}

/**
 * Arm the stuck-turn backstop while awaiting server acceptance of the turn
 * (`transcribing`/`thinking` before a `thinking` frame), clear it otherwise.
 * Every server signal re-syncs, so the timeout measures *silence from the
 * server*, not total turn duration. Once the server confirmed the turn
 * (`serverAcceptedTurn`) the backstop stays disarmed — `turn_cancelled` and
 * fatal `error` frames cover the turn's failure modes from there, and long
 * tool-using turns produce no frames between `thinking` and the first
 * delta. On expiry the session resumes listening (generation-guarded).
 */
function syncTurnBackstop(session: SessionContext): void {
  clearTurnBackstop(session);
  if (session.serverAcceptedTurn) return;
  const phase = useLiveVoiceStore.getState().state;
  if (phase !== "transcribing" && phase !== "thinking") return;

  const generation = session.generation;
  session.turnBackstopTimer = setTimeout(() => {
    session.turnBackstopTimer = null;
    if (session.generation !== generation) return;
    const now = useLiveVoiceStore.getState().state;
    if (now === "transcribing" || now === "thinking") {
      resumeListening(session);
    }
  }, session.stuckTurnTimeoutMs);
}

function clearTurnBackstop(session: SessionContext): void {
  if (session.turnBackstopTimer === null) return;
  clearTimeout(session.turnBackstopTimer);
  session.turnBackstopTimer = null;
}

/**
 * Resume listening for the next utterance: re-open the forwarding gate, clear
 * the per-utterance counters/flags, and move to `listening`. The mic is already
 * running (continuous capture) and the socket stays open, so there is nothing
 * to restart here.
 */
function resumeListening(session: SessionContext): void {
  clearTurnBackstop(session);
  session.forwardingAudio = true;
  session.interruptSent = false;
  session.responseAudioStarted = false;
  session.releaseInFlight = false;
  session.serverAcceptedTurn = false;
  session.speechMs = 0;
  session.silenceMs = 0;
  const s = useLiveVoiceStore.getState();
  s.setPartialTranscript("");
  s.setState("listening");
}

/**
 * Barge-in: stop playback and interrupt the server once per response. The
 * session stays open — the server confirms with an `interrupted` frame, which
 * flushes any straggler audio and resumes `listening` for the next utterance.
 */
function interruptIfSpeaking(session: SessionContext): void {
  if (useLiveVoiceStore.getState().state !== "speaking") return;
  if (!session.player.isPlaying || session.interruptSent) return;
  session.interruptSent = true;
  session.player.stop();
  session.client.interrupt();
}

/** First TTS frame of a response: reset playback flags for the new utterance. */
function beginAssistantAudioIfNeeded(session: SessionContext): void {
  if (session.responseAudioStarted) return;
  session.responseAudioStarted = true;
  session.interruptSent = false;
}

/**
 * After `tts_done`, await playback drain, then resume listening for the next
 * turn on the same socket. Forwarding is suspended during the drain so playback
 * audio captured by the (still-open) mic isn't streamed back. If an
 * `interrupted` frame resumed listening while we drained, leave the new turn
 * alone — resuming again would clear its in-flight counters/transcript.
 */
async function finishResponseAfterPlayback(
  session: SessionContext,
): Promise<void> {
  const generation = session.generation;
  session.responseAudioStarted = false;
  session.forwardingAudio = false;

  await session.player.waitUntilDrained();
  if (session.generation !== generation) return;
  if (useLiveVoiceStore.getState().state === "listening") return;
  resumeListening(session);
}

/**
 * Server-initiated session end: suspend forwarding, let buffered goodbye
 * audio finish playing, then tear down to idle. The `closed` handler defers
 * to this path (via `session.serverEnded`) so the socket close that follows
 * `session_ended` cannot cut the goodbye off.
 */
async function finishSessionAfterServerEnd(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  session.forwardingAudio = false;
  clearTurnBackstop(session);
  useLiveVoiceStore.getState().setState("ending");

  await session.player.waitUntilDrained();
  if (session.generation !== generation) return;
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
