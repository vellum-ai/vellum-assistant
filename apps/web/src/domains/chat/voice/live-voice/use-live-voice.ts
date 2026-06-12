/**
 * `useLiveVoice()` — session controller for the browser live-voice channel.
 *
 * Web-app counterpart to the macOS `LiveVoiceChannelManager`
 * (`clients/macos/.../LiveVoiceChannelManager.swift`). It wires the three merged
 * primitives — {@link LiveVoiceChannelClient} (transport), {@link
 * LiveVoiceAudioCapture} (mic → PCM), {@link LiveVoiceAudioPlayer} (TTS
 * playback) — into the session state machine and projects observable state into
 * {@link useLiveVoiceStore}.
 *
 * The state machine is held in `useLiveVoiceStore`; this module owns the imperative
 * glue (event wiring, barge-in, automatic push-to-talk release, teardown). One
 * controller instance drives at most one session at a time; `start()` while a
 * session is live is a no-op (matching the macOS guard).
 *
 * ## Single-utterance sessions
 * A live-voice session handles exactly one utterance → one response. The runtime
 * (and the macOS reference) treat `ptt_release` as terminal: once released, the
 * session never re-accepts audio (sending more yields `invalid_audio_payload`).
 * So this controller does NOT keep one socket open across turns — after the
 * assistant finishes speaking it ends the session (→ idle), and the user (or a
 * higher-level controller) starts a fresh one for the next turn. Every ended
 * session is reported through {@link UseLiveVoiceOptions.onSessionEnd} with a
 * reason and the server-issued conversation id, which is how the voice-mode
 * conversation loop (`useVoiceMode`) chains turns and reconnects after a
 * barge-in.
 *
 * ## State transitions (one session = one turn)
 * `idle → connecting` (start) → `listening` (ready + capture started) →
 * `transcribing` (ptt released) → `thinking` (server response) → `speaking`
 * (tts_audio) → `idle` (tts_done drained → session ended). The mic keeps
 * capturing for the whole session; `stop()`, teardown, an error, a server
 * `archived`/`closed`, or end-of-response returns to `idle`/`failed`.
 *
 * ## Mic forwarding
 * The mic capture graph runs for the entire active session so amplitude keeps
 * flowing for barge-in even while the assistant is thinking/speaking. Audio
 * *forwarding* (`session.forwardingAudio`) is gated to the user's turn: captured
 * PCM is streamed only while forwarding is on. Push-to-talk release flips
 * forwarding off (without stopping the mic); it is not re-opened within a
 * session (the session is single-utterance — see above).
 *
 * ## Barge-in
 * While `speaking`, a captured amplitude over {@link BARGE_IN_AMPLITUDE_THRESHOLD}
 * stops playback (20ms fade), sends `interrupt` (once per response), and ends
 * the session (→ idle) — the interrupted session is terminal on the runtime, so
 * a fresh session is needed to respond. The end is reported as
 * `onSessionEnd("interrupted", …)`; voice mode uses that to immediately open
 * the next session so `speaking → listening` feels seamless.
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
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  getTtsMuted,
  getTtsVolume,
  watchTtsOutputSettings,
} from "@/utils/tts-output-settings";

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Why a live-voice session ended. Lets a higher-level controller (voice mode)
 * decide whether to chain a follow-up session:
 *
 * - `completed` — the assistant finished speaking and playback drained.
 * - `interrupted` — barge-in stopped playback and interrupted the server.
 * - `stopped` — the consumer called `stop()`.
 * - `failed` — an error, `busy`, or unexpected transport close ended it.
 */
export type LiveVoiceSessionEndReason =
  | "completed"
  | "interrupted"
  | "stopped"
  | "failed";

export interface LiveVoiceSessionEndInfo {
  /**
   * Conversation the session was attached to (from the server `ready` /
   * `archived` frames), so a follow-up session can continue the same
   * conversation. `null` when the session never reached `ready`.
   */
  conversationId: string | null;
}

export interface UseLiveVoiceResult {
  /** Current session phase. */
  state: LiveVoiceSessionState;
  /** In-flight partial user transcript. */
  partialTranscript: string;
  /** Last finalized user transcript. */
  finalTranscript: string;
  /** Accumulated assistant response text for the current turn. */
  assistantTranscript: string;
  /** Smoothed mic amplitude in [0, 1]. */
  inputAmplitude: number;
  /** Failure message when `state === "failed"`, else `null`. */
  error: string | null;
  /** Start a session for `assistantId`, optionally attaching a conversation. */
  start: (assistantId: string, conversationId?: string) => Promise<void>;
  /** End the session and release the mic, socket, and audio context. */
  stop: () => Promise<void>;
  /**
   * Interrupt the assistant mid-`speaking` (button-triggered barge-in): same
   * path as the amplitude trigger — stop playback, send `interrupt`, end the
   * session, report `onSessionEnd("interrupted")`. No-op outside `speaking`.
   */
  interrupt: () => void;
}

/** Injectable factories so tests can supply mock primitives. */
export interface UseLiveVoiceOptions {
  createClient?: () => LiveVoiceChannelClient;
  createCapture?: (
    options: ConstructorParameters<typeof LiveVoiceAudioCapture>[0],
  ) => LiveVoiceAudioCapture;
  createPlayer?: () => LiveVoiceAudioPlayer;
  /**
   * Invoked exactly once per session, after the session's primitives are torn
   * down, with the reason it ended. Read fresh from the latest options at
   * fire time, so consumers may pass an inline function.
   */
  onSessionEnd?: (
    reason: LiveVoiceSessionEndReason,
    info: LiveVoiceSessionEndInfo,
  ) => void;
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
   * is speaking (`listening`); turned off after an automatic push-to-talk
   * release. A live-voice session is single-utterance (the runtime treats
   * `ptt_release` as terminal — it never re-accepts audio), so forwarding is not
   * re-opened within a session: the session ends after the response, and a fresh
   * session is started for the next turn. Amplitude keeps flowing regardless so
   * barge-in works while not forwarding.
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
  /** Conversation id from the server `ready`/`archived` frames, if any. */
  conversationId: string | null;
  /**
   * Report why this session ended to the consumer's `onSessionEnd`. At most
   * one report fires per session (teardown paths can overlap, e.g. an
   * interrupt racing a transport close).
   */
  notifySessionEnd: (reason: LiveVoiceSessionEndReason) => void;
  /** Whether `notifySessionEnd` already fired for this session. */
  endNotified: boolean;
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
  const state = useLiveVoiceStore.use.state();
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  const inputAmplitude = useLiveVoiceStore.use.inputAmplitude();
  const error = useLiveVoiceStore.use.error();

  const sessionRef = useRef<SessionContext | null>(null);

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
    sessionRef.current = null;
    session.generation += 1;
    useLiveVoiceStore.getState().setState("ending");
    for (const unsubscribe of session.unsubscribes) unsubscribe();
    session.unsubscribes = [];
    session.client.end();
    // Release the AudioContext, not just the scheduled sources (see teardown).
    await session.player.dispose();
    await session.capture.shutdown();
    useLiveVoiceStore.getState().reset();
    session.notifySessionEnd("stopped");
  }, []);

  const start = useCallback(
    async (assistantId: string, conversationId?: string) => {
      const current = sessionRef.current;
      // A live session (anything but idle/failed) blocks a new start.
      const phase = useLiveVoiceStore.getState().state;
      if (current && phase !== "idle" && phase !== "failed") return;
      if (current) teardown();

      const store = useLiveVoiceStore.getState();
      store.reset();
      store.setState("connecting");

      const opts = optionsRef.current;
      const client = (opts.createClient ?? (() => new LiveVoiceChannelClient()))();
      // The default player starts at the user's persisted TTS output
      // preference; the watcher below keeps it live for the session.
      const player = (
        opts.createPlayer ??
        (() =>
          new LiveVoiceAudioPlayer({
            volume: getTtsVolume(),
            muted: getTtsMuted(),
          }))
      )();

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
        conversationId: conversationId ?? null,
        endNotified: false,
        notifySessionEnd: (reason) => {
          if (session.endNotified) return;
          session.endNotified = true;
          // Read the callback fresh so inline option objects stay current.
          optionsRef.current.onSessionEnd?.(reason, {
            conversationId: session.conversationId,
          });
        },
      };

      session.unsubscribes.push(
        watchTtsOutputSettings(() => {
          player.setVolume(getTtsVolume());
          player.setMuted(getTtsMuted());
        }),
      );

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
          // Capture the conversation the server attached/created so a
          // follow-up session (voice mode's next turn) can continue it.
          session.conversationId = frame.conversationId || session.conversationId;
          void startCapture(session, teardown);
        }),
        client.on("sttPartial", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setPartialTranscript(frame.text);
          // Only while still forwarding (the user's turn) does a partial keep
          // us in `listening`; after ptt-release we're transcribing/thinking.
          if (session.forwardingAudio) s.setState("listening");
        }),
        client.on("sttFinal", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setFinalTranscript(frame.text);
          s.setPartialTranscript("");
          // Forwarding ⇒ the user is still speaking (stay listening); otherwise
          // ptt was released and the server is about to think.
          s.setState(session.forwardingAudio ? "listening" : "thinking");
        }),
        client.on("thinking", () => {
          if (!live()) return;
          // New response: reset the per-response transcript and barge-in flags.
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
        client.on("archived", (frame) => {
          if (!live()) return;
          // Persisted; keep the conversation id current for follow-up turns.
          session.conversationId = frame.conversationId || session.conversationId;
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
          // resets the store to idle.
          if (!live()) return;
          teardown();
          session.notifySessionEnd("failed");
        }),
      );

      await client.connect({ assistantId, conversationId });
    },
    [teardown],
  );

  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    interruptIfSpeaking(session, teardown);
  }, [teardown]);

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
    error,
    start,
    stop,
    interrupt,
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
function handleAmplitude(
  session: SessionContext,
  amplitude: number,
  teardown: () => void,
): void {
  if (!session.captureRunning) return;
  useLiveVoiceStore.getState().setInputAmplitude(amplitude);
  if (amplitude >= BARGE_IN_AMPLITUDE_THRESHOLD) {
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
 * Resume listening for the next utterance: re-open the forwarding gate, clear
 * the per-utterance counters/flags, and move to `listening`. The mic is already
 * running (continuous capture), so there is nothing to restart here.
 */
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
  session.notifySessionEnd("interrupted");
}

/** First TTS frame of a response: reset playback flags for the new utterance. */
function beginAssistantAudioIfNeeded(session: SessionContext): void {
  if (session.responseAudioStarted) return;
  session.responseAudioStarted = true;
  session.interruptSent = false;
}

/**
 * After `tts_done`, await playback drain, then end the session (→ idle).
 *
 * A live-voice session is single-utterance: once `ptt_release` fires the runtime
 * won't accept more audio on it, so we don't resume listening on the same
 * socket — we tear the session down and the user starts a fresh one for the next
 * turn (mirrors the macOS `closeCompletedUtteranceSessionAfterPlayback`).
 * Forwarding is suspended during the drain so playback audio captured by the
 * (still-open) mic isn't streamed back. Any teardown that raced the drain —
 * barge-in (which reconnects a fresh session), stop(), unmount — bumped the
 * generation, so the stale-session guard below covers all of them.
 *
 * Runs for silent turns too: `tts_done` can arrive without any prior
 * `tts_audio` (no speakable text, or a zero-chunk TTS stream), in which case
 * the session never reached `speaking` (it is still `thinking`). The drain
 * resolves immediately and the turn must still complete — and report
 * `completed` so the voice-mode loop opens the next listening session — the
 * same way the macOS `syncLiveVoiceState` restarts the loop when a turn lands
 * on `idle` without speaking.
 */
async function finishResponseAfterPlayback(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  session.responseAudioStarted = false;
  session.forwardingAudio = false;

  await session.player.waitUntilDrained();
  if (session.generation !== generation) return;

  teardown();
  session.notifySessionEnd("completed");
}

/** Fail the session: tear down primitives and surface the message. */
function finishWithError(
  session: SessionContext,
  teardown: () => void,
  message: string,
): void {
  teardown();
  useLiveVoiceStore.getState().fail(message);
  session.notifySessionEnd("failed");
}
