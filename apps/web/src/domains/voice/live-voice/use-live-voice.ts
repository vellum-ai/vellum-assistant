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
 * ## State transitions (full turn)
 * `idle → connecting` (start) → `listening` (ready + capture started) →
 * `transcribing` (ptt released) → `thinking` (server response) → `speaking`
 * (tts_audio) → `idle` (tts_done drained + cleanup).
 *
 * ## Barge-in
 * While `speaking`, a captured amplitude over {@link BARGE_IN_AMPLITUDE_THRESHOLD}
 * stops playback and sends `interrupt` (once per response).
 *
 * ## Automatic push-to-talk release
 * While `listening`, sustained speech (≥ {@link MINIMUM_SPEECH_DURATION_BEFORE_RELEASE_MS})
 * followed by {@link SILENCE_DURATION_BEFORE_RELEASE_MS} of silence releases
 * push-to-talk and moves to `transcribing`.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  LiveVoiceChannelClient,
  type LiveVoiceClientError,
} from "@/domains/voice/live-voice/live-voice-client";
import {
  LiveVoiceAudioCapture,
  LIVE_VOICE_AUDIO_FORMAT,
} from "@/domains/voice/live-voice/pcm-capture";
import {
  LiveVoiceAudioPlayer,
  type TtsAudioChunk,
} from "@/domains/voice/live-voice/tts-playback";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/voice/live-voice/live-voice-store";

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
}

/** Injectable factories so tests can supply mock primitives. */
export interface UseLiveVoiceOptions {
  createClient?: () => LiveVoiceChannelClient;
  createCapture?: (
    options: ConstructorParameters<typeof LiveVoiceAudioCapture>[0],
  ) => LiveVoiceAudioCapture;
  createPlayer?: () => LiveVoiceAudioPlayer;
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
  captureRunning: boolean;
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
  // even if callers pass inline option objects.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** Tear down the active session's primitives and clear the ref. */
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
      const player = (opts.createPlayer ?? (() => new LiveVoiceAudioPlayer()))();

      const session: SessionContext = {
        client,
        capture: undefined as unknown as LiveVoiceAudioCapture,
        player,
        unsubscribes: [],
        generation: 0,
        captureRunning: false,
        responseAudioStarted: false,
        interruptSent: false,
        releaseInFlight: false,
        speechMs: 0,
        silenceMs: 0,
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
        client.on("ready", () => {
          if (!live()) return;
          void startCapture(session, teardown);
        }),
        client.on("sttPartial", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setPartialTranscript(frame.text);
          if (session.captureRunning) s.setState("listening");
        }),
        client.on("sttFinal", (frame) => {
          if (!live()) return;
          const s = useLiveVoiceStore.getState();
          s.setFinalTranscript(frame.text);
          s.setPartialTranscript("");
          s.setState(session.captureRunning ? "listening" : "thinking");
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
          finishWithError(session, teardown, err.message);
        }),
        client.on("closed", () => {
          // A transport close after a clean end()/teardown is expected; only an
          // unexpected close while still attached needs cleanup.
          if (!live()) return;
          teardown();
          useLiveVoiceStore.getState().reset();
        }),
      );

      await client.connect({ assistantId, conversationId });
    },
    [teardown],
  );

  // Release everything if the consumer unmounts mid-session.
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
  const s = useLiveVoiceStore.getState();
  if (s.state === "connecting") s.setState("listening");
}

/** Forward a captured PCM chunk to the server and drive silence detection. */
function handleChunk(session: SessionContext, buf: ArrayBuffer): void {
  if (!session.captureRunning) return;
  session.client.sendAudio(buf);
  updateAutomaticRelease(session, buf);
}

/** Apply the latest amplitude to the store and run barge-in detection. */
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

/** Stop forwarding audio and release push-to-talk; moves to `transcribing`. */
function releasePushToTalk(session: SessionContext): void {
  if (session.releaseInFlight || !session.captureRunning) return;
  session.releaseInFlight = true;
  session.captureRunning = false;
  void session.capture.stop();
  session.client.pttRelease();
  const s = useLiveVoiceStore.getState();
  if (s.state === "listening") s.setState("transcribing");
  s.setInputAmplitude(0);
}

/** Barge-in: stop playback and interrupt the server once per response. */
function interruptIfSpeaking(session: SessionContext): void {
  if (useLiveVoiceStore.getState().state !== "speaking") return;
  if (!session.player.isPlaying || session.interruptSent) return;
  session.interruptSent = true;
  session.player.stop();
  session.client.interrupt();
  const s = useLiveVoiceStore.getState();
  s.setState(session.captureRunning ? "listening" : "idle");
}

/** First TTS frame of a response: reset playback flags for the new utterance. */
function beginAssistantAudioIfNeeded(session: SessionContext): void {
  if (session.responseAudioStarted) return;
  session.responseAudioStarted = true;
  session.interruptSent = false;
}

/**
 * After `tts_done`, stop capturing then await playback drain before cleaning up
 * and returning to `idle`. Stopping capture first prevents drain-window audio
 * from being forwarded (mirrors the macOS ordering).
 */
async function finishResponseAfterPlayback(
  session: SessionContext,
  teardown: () => void,
): Promise<void> {
  const generation = session.generation;
  session.responseAudioStarted = false;
  session.captureRunning = false;
  void session.capture.stop();

  await session.player.waitUntilDrained();
  if (session.generation !== generation) return;

  useLiveVoiceStore.getState().setState("ending");
  teardown();
  useLiveVoiceStore.getState().reset();
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
