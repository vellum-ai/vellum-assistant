/**
 * Duplex audio ingest for in-app live voice sessions.
 *
 * The PCM16 analogue of `src/calls/media-stream-stt-session.ts`: raw PCM16
 * audio chunks flow through an energy VAD ({@link detectPcm16SpeechActivity})
 * and a {@link MediaTurnDetector} for turn segmentation, and are transcribed
 * in one of two modes:
 *
 * - **Streaming** (default) — chunks are fed to a
 *   {@link StreamingTranscriber} resolved for the configured `services.stt`
 *   provider in two tiers: utterance-boundary finals when the provider
 *   supports them (`"boundary"` tier — Deepgram), otherwise plain streaming
 *   (`"plain"` tier — live partials flow, and the ingest forces the
 *   utterance final at each local turn boundary by stopping the provider
 *   session and starting a fresh one for the next turn). Partials are
 *   forwarded via `onPartial` (the in-app UI displays live transcripts);
 *   non-empty finals fire `onTranscriptFinal`. Chunks arriving while the
 *   provider session is starting (or restarting between plain-tier turns)
 *   are held in a bounded buffer and flushed on start (overflow drops the
 *   oldest chunks and is counted + logged at teardown).
 * - **Batch** — segmented audio turns are wrapped in a WAV container and
 *   transcribed per turn via the batch transcriber, strictly in turn order.
 *   Used when no streaming transcriber is available for the configured
 *   provider or the provider closed the streaming session unexpectedly
 *   mid-session.
 *
 * Speech-start (`onSpeechStart`) and turn boundaries (`onTurnBoundary`)
 * always come from the local VAD/turn detector, never from transcriber
 * events — the session layer decides what they mean (barge-in in open-mic,
 * informational in PTT).
 *
 * The session `mode` drives turn detection: in `open-mic`, trailing silence
 * (`vad.silenceThresholdMs`) auto-ends the user's turn; in `ptt`, silence
 * never ends a turn — turns end only via {@link LiveVoiceIngest.forceTurnEnd}
 * (the client's `ptt_release`) or the `vad.maxTurnDurationMs` hard cap.
 * The VAD's `onSpeechStart` fires in both modes (barge-in needs it).
 *
 * This module is **transport-neutral** — it exposes callback hooks rather
 * than driving any session flow itself; the live-voice session instantiates
 * it and connects it to the client WebSocket ingress.
 */

import { MediaTurnDetector } from "../calls/media-turn-detector.js";
import type { LiveVoiceVadConfig } from "../config/schemas/live-voice.js";
import {
  resolveBatchTranscriber,
  resolveStreamingTranscriber,
  type ResolveStreamingTranscriberOptions,
} from "../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../stt/daemon-batch-transcriber.js";
import type {
  BatchTranscriber,
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import { encodePcm16LeToWav } from "../stt/wav-encoder.js";
import { getLogger } from "../util/logger.js";
import { detectPcm16SpeechActivity } from "./pcm-speech-activity.js";
import type { LiveVoiceSessionMode } from "./protocol.js";

const log = getLogger("live-voice-ingest");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LiveVoiceIngestConfig {
  /** Sample rate of the inbound PCM16 audio in Hz. */
  sampleRate: number;

  /**
   * Microphone mode the session negotiated. Drives turn detection:
   * `open-mic` auto-ends turns after `vad.silenceThresholdMs` of trailing
   * silence; `ptt` disables silence-based auto-end — turns end only via
   * {@link LiveVoiceIngest.forceTurnEnd} (client `ptt_release`) or the
   * `vad.maxTurnDurationMs` cap. Speech-start detection runs in both modes.
   */
  mode: LiveVoiceSessionMode;

  /** VAD thresholds (from `getConfig().liveVoice.vad` at the call site). */
  vad: LiveVoiceVadConfig;

  /**
   * Maximum number of audio chunks buffered while the streaming
   * transcriber starts up. Default: 500.
   */
  streamingStartupBufferFrames?: number;

  /** Per-request batch transcription timeout in milliseconds. Default: 10_000. */
  transcriptionTimeoutMs?: number;
}

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10_000;

/** Default bound for the startup chunk buffer. */
const DEFAULT_STREAMING_STARTUP_BUFFER_FRAMES = 500;

/**
 * Silence threshold used in `ptt` mode: the maximum delay `setTimeout`
 * supports (2^31 - 1 ms, ~24.8 days), so the turn detector's silence timer
 * effectively never fires and turns end only via `forceTurnEnd` (client
 * `ptt_release`) or the max-turn-duration cap.
 */
const PTT_SILENCE_THRESHOLD_MS = 2 ** 31 - 1;

/**
 * Transcription mode:
 * - `"batch"` — per-turn batch transcription via {@link MediaTurnDetector}.
 * - `"streaming-pending"` — streaming selected; provider session still
 *   starting, chunks buffered.
 * - `"streaming"` — live streaming session active. Falls back to
 *   `"batch"` if the provider closes the stream unexpectedly mid-session.
 */
type IngestMode = "batch" | "streaming-pending" | "streaming";

// ---------------------------------------------------------------------------
// Callback hooks
// ---------------------------------------------------------------------------

export interface LiveVoiceIngestCallbacks {
  /**
   * Called when the local VAD detects the start of user speech (first
   * speech-bearing chunk of a new turn). Fires in every mode — the session
   * decides whether it means barge-in.
   */
  onSpeechStart?: () => void;

  /**
   * Called with interim transcript text (streaming mode only). The text
   * may be revised by subsequent partials or finals.
   */
  onPartial?: (text: string) => void;

  /**
   * Called when a completed user utterance has been transcribed.
   *
   * Batch mode: fires per detected turn; text may be empty for turns whose
   * audio transcribed to nothing. Streaming mode: fires per
   * utterance-boundary final from the provider; empty finals are suppressed.
   *
   * @param text - The transcribed text (trimmed).
   * @param durationMs - Approximate duration of the audio turn, when known.
   */
  onTranscriptFinal?: (text: string, durationMs?: number) => void;

  /**
   * Called when the local turn detector ends a turn (silence threshold,
   * max duration, or {@link LiveVoiceIngest.forceTurnEnd}).
   */
  onTurnBoundary?: () => void;

  /**
   * Called when an error occurs (provider error, timeout, no-provider, etc.).
   *
   * @param category - A structured error category.
   * @param message - Human-readable description.
   */
  onError?: (category: string, message: string) => void;

  /** Called when the ingest is deliberately stopped via {@link LiveVoiceIngest.stop}. */
  onStop?: () => void;
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export type LiveVoiceIngestStreamingResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export type LiveVoiceIngestBatchResolver =
  () => Promise<BatchTranscriber | null>;

/** Resolver seams — production defaults are the catalog-backed resolvers. */
export interface LiveVoiceIngestDeps {
  resolveStreamingTranscriber?: LiveVoiceIngestStreamingResolver;
  resolveBatchTranscriber?: LiveVoiceIngestBatchResolver;
}

// ---------------------------------------------------------------------------
// Two-tier streaming resolution
// ---------------------------------------------------------------------------

/**
 * How a resolved streaming transcriber delivers utterance finals.
 *
 * - `"boundary"` — the provider emits `final` events at utterance
 *   boundaries itself (Deepgram).
 * - `"plain"` — the provider streams live partials but only emits its
 *   `final` at end-of-stream (or per committed segment), so the ingest
 *   forces the utterance final at each local turn boundary by stopping the
 *   provider session and starting a fresh one for the next turn.
 */
export type LiveVoiceStreamingTier = "boundary" | "plain";

/** A streaming transcriber together with the tier it resolved under. */
export interface TieredStreamingTranscriber {
  transcriber: StreamingTranscriber;
  tier: LiveVoiceStreamingTier;
}

/**
 * Resolve a streaming transcriber for live voice in two tiers: first with
 * utterance-boundary finals (`"boundary"`), then plain streaming
 * (`"plain"`). Returns `null` only when neither tier resolves — the caller
 * falls back to per-turn batch transcription.
 *
 * Shared by {@link LiveVoiceIngest} (runtime) and the live-voice credential
 * preflight, so the preflight's ready/not-ready verdict validates exactly
 * the legs the runtime will use.
 */
export async function resolveTieredStreamingTranscriber(
  resolve: LiveVoiceIngestStreamingResolver,
  sampleRate?: number,
): Promise<TieredStreamingTranscriber | null> {
  const rateOption = sampleRate === undefined ? {} : { sampleRate };
  const boundary = await resolve({
    ...rateOption,
    utteranceBoundaryFinals: true,
  });
  if (boundary) {
    return { transcriber: boundary, tier: "boundary" };
  }
  const plain = await resolve(rateOption);
  if (plain) {
    return { transcriber: plain, tier: "plain" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export class LiveVoiceIngest {
  private readonly config: LiveVoiceIngestConfig;
  private readonly callbacks: LiveVoiceIngestCallbacks;
  private readonly resolveStreaming: LiveVoiceIngestStreamingResolver;
  private readonly resolveBatch: LiveVoiceIngestBatchResolver;
  private readonly turnDetector: MediaTurnDetector;
  private readonly transcriptionTimeoutMs: number;
  private readonly streamingMimeType: string;

  /** Raw PCM16 chunks for the current turn (batch / streaming-pending). */
  private currentTurnChunks: Buffer[] = [];

  /** Whether the ingest has been disposed. */
  private disposed = false;

  /** Session-level abort controller for the active batch transcription. */
  private activeTranscriptionAbort: AbortController | null = null;

  /** Transcription mode — settled by {@link startStreaming}. */
  private mode: IngestMode = "batch";

  /** Live streaming transcriber (streaming mode only). */
  private streamingTranscriber: StreamingTranscriber | null = null;

  /**
   * Tier the streaming transcriber resolved under. Settled by the first
   * successful resolution; plain-tier restarts skip the boundary attempt
   * (it would re-log the fallback warning every turn).
   */
  private streamingTier: LiveVoiceStreamingTier | null = null;

  /**
   * Serializes per-turn batch transcriptions (and empty-turn finals) so
   * `onTranscriptFinal` fires strictly in turn order even when an earlier
   * turn's transcription request is slower than a later one.
   */
  private batchTurnQueue: Promise<void> = Promise.resolve();

  /**
   * Whether the ingest deliberately stopped the streaming transcriber
   * ({@link stop} or {@link dispose}). Distinguishes expected `closed`
   * events from provider-initiated closes, which trigger batch fallback.
   */
  private deliberateStop = false;

  /**
   * Turns the local VAD completed while the mode was `streaming-pending`,
   * queued with their buffered audio. {@link enterBatchMode} transcribes
   * them in order if streaming never materializes. Cleared when streaming
   * settles active and on dispose.
   */
  private pendingCompletedTurns: { chunks: Buffer[]; durationMs: number }[] =
    [];

  /** Chunks buffered while the streaming transcriber starts up. */
  private startupFrames: Buffer[] = [];

  /** Bound for {@link startupFrames}. */
  private readonly startupBufferFrames: number;

  /** Chunks evicted from the startup buffer on overflow. */
  private startupFramesDroppedCount = 0;

  /** Whether the startup-drop metric has been logged at teardown. */
  private startupDropsLogged = false;

  /** Speech-bearing audio milliseconds since the last streaming final. */
  private utteranceAudioMs = 0;

  constructor(
    config: LiveVoiceIngestConfig,
    callbacks: LiveVoiceIngestCallbacks = {},
    deps: LiveVoiceIngestDeps = {},
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.resolveStreaming =
      deps.resolveStreamingTranscriber ?? resolveStreamingTranscriber;
    this.resolveBatch = deps.resolveBatchTranscriber ?? resolveBatchTranscriber;
    this.transcriptionTimeoutMs =
      config.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
    this.startupBufferFrames =
      config.streamingStartupBufferFrames ??
      DEFAULT_STREAMING_STARTUP_BUFFER_FRAMES;
    this.streamingMimeType = `audio/pcm;rate=${config.sampleRate}`;

    this.turnDetector = new MediaTurnDetector(
      {
        // PTT: silence never auto-ends a turn — the turn ends only on
        // forceTurnEnd (client ptt_release) or the max-duration cap.
        // Open-mic: trailing silence is the primary turn-end signal.
        silenceThresholdMs:
          config.mode === "ptt"
            ? PTT_SILENCE_THRESHOLD_MS
            : config.vad.silenceThresholdMs,
        maxTurnDurationMs: config.vad.maxTurnDurationMs,
      },
      {
        onTurnStart: () => {
          // Clear inter-turn silence that accumulated while idle so each
          // transcription request contains only speech-relevant chunks.
          this.currentTurnChunks = [];
          this.callbacks.onSpeechStart?.();
        },
        onTurnEnd: (_reason, durationMs) => {
          this.callbacks.onTurnBoundary?.();
          this.handleTurnEnd(durationMs);
        },
      },
    );
  }

  /**
   * Begin ingesting. Enters `streaming-pending` and resolves the streaming
   * transcriber; settles to batch when streaming is unavailable.
   */
  start(): void {
    if (this.disposed) {
      return;
    }
    this.mode = "streaming-pending";
    void this.startStreaming();
  }

  /**
   * Feed a raw PCM16-LE mono audio chunk into the ingest pipeline.
   */
  pushAudio(chunk: Buffer): void {
    if (this.disposed) {
      return;
    }

    // The detector call runs BEFORE the push so that the onTurnStart
    // callback can clear stale inter-turn silence from the buffer
    // without also wiping the first speech chunk of the new turn.
    //
    // The detector runs in every mode: in streaming mode it drives
    // speech-start and turn boundaries (`onSpeechStart`/`onTurnBoundary`
    // fire from this local VAD, never from transcriber events).
    const hasSpeech = detectPcm16SpeechActivity(
      chunk,
      this.config.vad.speechEnergyThreshold,
    );
    this.turnDetector.onMediaChunk(hasSpeech);

    if (this.mode === "batch") {
      this.currentTurnChunks.push(chunk);
      return;
    }

    // Approximate the utterance duration reported with streaming finals:
    // count audio while the local VAD sees an active turn.
    if (hasSpeech || this.turnDetector.isActive) {
      this.utteranceAudioMs +=
        chunk.length / 2 / (this.config.sampleRate / 1000);
    }

    if (this.mode === "streaming") {
      this.streamingTranscriber?.sendAudio(chunk, this.streamingMimeType);
      return;
    }

    // streaming-pending: the provider session is still starting. Buffer
    // the chunk for the flush, and keep filling the turn buffer so a batch
    // fallback still has the audio.
    this.bufferStartupFrame(chunk);
    this.currentTurnChunks.push(chunk);
  }

  /**
   * End the current utterance immediately — the PTT release path (and the
   * only silence-independent turn-end signal in `ptt` mode).
   *
   * Flushes the turn detector: in batch mode the buffered turn is
   * transcribed now; in boundary-tier streaming the provider's
   * utterance-boundary finals deliver the transcript; in plain-tier
   * streaming the ingest forces the final by cycling the provider session.
   */
  forceTurnEnd(): void {
    this.turnDetector.forceEnd();
  }

  /**
   * Deliberate teardown: finalize any in-flight turn, stop the streaming
   * transcriber without triggering batch fallback, and fire `onStop`.
   *
   * Streaming: the provider may flush a trailing final after stop, which
   * is still forwarded via `onTranscriptFinal`.
   */
  stop(): void {
    if (this.disposed) {
      return;
    }
    // Set before forceEnd so a plain-tier turn end skips its stop/restart
    // cycle — the direct stop below flushes the trailing final instead.
    this.deliberateStop = true;
    this.turnDetector.forceEnd();
    stopStreamingBestEffort(this.streamingTranscriber);
    this.logStartupDrops();
    this.callbacks.onStop?.();
  }

  /**
   * Dispose of the ingest, clearing all timers and buffers, aborting any
   * in-flight batch transcription, and stopping the streaming transcriber.
   */
  dispose(): void {
    this.disposed = true;
    this.deliberateStop = true;
    this.activeTranscriptionAbort?.abort();
    this.activeTranscriptionAbort = null;
    this.turnDetector.dispose();
    this.currentTurnChunks = [];
    this.pendingCompletedTurns = [];
    this.startupFrames = [];
    const transcriber = this.streamingTranscriber;
    this.streamingTranscriber = null;
    stopStreamingBestEffort(transcriber);
    this.logStartupDrops();
  }

  /** Chunks dropped from the bounded streaming startup buffer. */
  get streamingStartupFramesDropped(): number {
    return this.startupFramesDroppedCount;
  }

  // ── Streaming mode ─────────────────────────────────────────────────

  /**
   * Resolve and start the streaming transcriber (two-tier: boundary
   * finals, then plain streaming), then flush the chunks buffered during
   * startup. Falls back to the batch path when neither tier resolves or
   * the provider session cannot be established — the mode is settled
   * before streaming ever becomes active, so modes are never mixed
   * mid-session. Also serves plain-tier per-turn restarts, which reuse
   * the same startup-buffer machinery for the restart gap.
   */
  private async startStreaming(): Promise<void> {
    let resolved: TieredStreamingTranscriber | null = null;
    try {
      if (this.streamingTier === "plain") {
        // Per-turn restart: the tier already settled plain — skip the
        // boundary attempt (it would re-log its fallback warning per turn).
        const transcriber = await this.resolveStreaming({
          sampleRate: this.config.sampleRate,
        });
        resolved = transcriber ? { transcriber, tier: "plain" } : null;
      } else {
        resolved = await resolveTieredStreamingTranscriber(
          this.resolveStreaming,
          this.config.sampleRate,
        );
      }
    } catch (err) {
      log.warn(
        { error: err },
        "Streaming transcriber resolution failed — falling back to batch STT",
      );
    }

    if (this.disposed || this.deliberateStop) {
      stopStreamingBestEffort(resolved?.transcriber ?? null);
      return;
    }

    if (!resolved) {
      this.enterBatchMode();
      return;
    }

    const { transcriber, tier } = resolved;
    try {
      await transcriber.start((event) =>
        this.handleStreamingEvent(event, transcriber),
      );
    } catch (err) {
      log.warn(
        { error: err },
        "Streaming transcriber failed to start — falling back to batch STT",
      );
      if (!this.disposed) {
        this.enterBatchMode();
      }
      return;
    }

    if (this.disposed || this.deliberateStop) {
      stopStreamingBestEffort(transcriber);
      return;
    }

    this.streamingTranscriber = transcriber;
    this.streamingTier = tier;
    this.mode = "streaming";

    // Flush audio buffered while the provider session was starting.
    const buffered = this.startupFrames;
    this.startupFrames = [];
    for (const frame of buffered) {
      transcriber.sendAudio(frame, this.streamingMimeType);
    }

    // The batch fallback is settled — drop its turn buffers.
    this.currentTurnChunks = [];
    this.pendingCompletedTurns = [];
  }

  /**
   * Settle on the batch path.
   *
   * Turns the local VAD already completed while streaming was pending are
   * stranded — {@link handleTurnEnd} deferred them to streaming finals
   * that will never arrive — so the queue is batch-transcribed here in
   * order. This recovery applies only to the pending path: on a mid-session
   * provider close, an in-progress turn's earlier audio already went to
   * the dead provider, and only audio arriving after the fallback is
   * batch-transcribed.
   */
  private enterBatchMode(): void {
    this.mode = "batch";
    this.startupFrames = [];

    const pending = this.pendingCompletedTurns;
    this.pendingCompletedTurns = [];
    if (pending.length > 0) {
      log.info(
        { turnCount: pending.length },
        "Transcribing turns completed during streaming startup via batch fallback",
      );
      for (const { chunks, durationMs } of pending) {
        this.enqueueTurnTranscription(chunks, durationMs);
      }
    }
  }

  /**
   * Map streaming transcriber events onto the ingest callbacks.
   *
   * Partials are forwarded (the in-app UI displays live transcripts) but
   * never drive turn-taking: turn boundaries come from the local VAD and
   * transcripts commit on the provider's finals (utterance-boundary finals
   * in the boundary tier; per-turn forced finals in the plain tier).
   *
   * @param source - The transcriber that emitted the event, so `closed`
   *   from a deliberately replaced plain-tier session is not mistaken for
   *   a provider-initiated close of the live one.
   */
  private handleStreamingEvent(
    event: SttStreamServerEvent,
    source: StreamingTranscriber,
  ): void {
    if (this.disposed) {
      return;
    }

    switch (event.type) {
      case "partial":
        this.callbacks.onPartial?.(event.text);
        return;
      case "final": {
        const durationMs = Math.round(this.utteranceAudioMs);
        this.utteranceAudioMs = 0;
        const text = event.text.trim();
        if (text.length > 0) {
          this.callbacks.onTranscriptFinal?.(text, durationMs);
        }
        return;
      }
      case "error":
        this.callbacks.onError?.(event.category, event.message);
        return;
      case "closed":
        if (this.streamingTranscriber !== source) {
          // Stale close from a stopped/replaced session (e.g. the previous
          // plain-tier turn's transcriber) — the live session is unaffected.
          return;
        }
        this.streamingTranscriber = null;
        // Provider-initiated close mid-session: without a live transcriber
        // the streaming mode would silently drop all subsequent audio.
        // Fall back to per-turn batch transcription (the local VAD/turn
        // detector already runs in streaming mode).
        if (this.mode === "streaming" && !this.deliberateStop) {
          log.warn(
            "Streaming transcriber closed unexpectedly mid-session — falling back to batch STT",
          );
          this.enterBatchMode();
        }
        return;
    }
  }

  /**
   * Force the just-ended turn's utterance final in the plain streaming
   * tier: stop the provider session (plain-tier providers flush their
   * final at end-of-stream — V1's ptt_release did exactly this) and start
   * a fresh session for the next turn, reusing the startup-buffer
   * machinery so no audio is lost in the restart gap.
   */
  private async restartPlainStreamingForNextTurn(): Promise<void> {
    const transcriber = this.streamingTranscriber;
    this.streamingTranscriber = null;
    this.mode = "streaming-pending";
    stopStreamingBestEffort(transcriber);
    await this.startStreaming();
  }

  /**
   * Append a chunk to the bounded startup buffer. On overflow the oldest
   * chunk is dropped and counted; the total is logged at teardown.
   */
  private bufferStartupFrame(chunk: Buffer): void {
    this.startupFrames.push(chunk);
    if (this.startupFrames.length > this.startupBufferFrames) {
      this.startupFrames.shift();
      this.startupFramesDroppedCount++;
    }
  }

  /** Log the startup-buffer drop count once, if any chunks were dropped. */
  private logStartupDrops(): void {
    if (this.startupDropsLogged || this.startupFramesDroppedCount === 0) {
      return;
    }
    this.startupDropsLogged = true;
    log.warn(
      { streamingStartupFramesDropped: this.startupFramesDroppedCount },
      "Dropped audio chunks during streaming transcriber startup",
    );
  }

  // ── Turn completion ────────────────────────────────────────────────

  private handleTurnEnd(durationMs: number): void {
    // Streaming modes take transcripts from the provider's finals, not
    // the local VAD. Turns completed while streaming is still pending are
    // queued so a later batch fallback can transcribe their buffered audio.
    if (this.mode !== "batch") {
      if (this.mode === "streaming-pending") {
        const chunks = this.currentTurnChunks;
        this.currentTurnChunks = [];
        if (chunks.length > 0) {
          this.pendingCompletedTurns.push({ chunks, durationMs });
        }
        return;
      }
      // Plain-tier streaming never emits an utterance-boundary final on
      // its own — force it by cycling the provider session. (During a
      // deliberate stop the direct transcriber stop flushes it instead.)
      if (this.streamingTier === "plain" && !this.deliberateStop) {
        void this.restartPlainStreamingForNextTurn();
      }
      return;
    }

    // Capture the turn's audio synchronously (the next turn's onTurnStart
    // clears the buffer), then transcribe on the serialized queue so
    // finals emit strictly in turn order.
    const chunks = this.currentTurnChunks;
    this.currentTurnChunks = [];
    this.enqueueTurnTranscription(chunks, durationMs);
  }

  /**
   * Chain a completed turn onto the serialized transcription queue.
   * Empty (silence) turns emit an empty final from the same queue so
   * ordering holds across every turn kind.
   */
  private enqueueTurnTranscription(chunks: Buffer[], durationMs: number): void {
    this.batchTurnQueue = this.batchTurnQueue.then(async () => {
      if (this.disposed) {
        return;
      }
      if (chunks.length === 0) {
        // Silence turn — no audio to transcribe.
        this.callbacks.onTranscriptFinal?.("", durationMs);
        return;
      }
      await this.transcribeTurn(chunks, durationMs);
    });
  }

  /** Batch-transcribe a completed turn's audio chunks. */
  private async transcribeTurn(
    chunks: Buffer[],
    durationMs: number,
  ): Promise<void> {
    // Wrap the raw PCM16 in a WAV container so downstream transcribers
    // (e.g. Whisper) receive a recognised audio format with correct headers.
    const audioBuffer = encodePcm16LeToWav(Buffer.concat(chunks), {
      sampleRate: this.config.sampleRate,
      channels: 1,
    });

    // Resolve a batch transcriber for the configured provider.
    let transcriber: BatchTranscriber | null;
    try {
      transcriber = await this.resolveBatch();
    } catch (err) {
      if (this.disposed) {
        return;
      }
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
      return;
    }
    if (this.disposed) {
      return;
    }

    if (!transcriber) {
      this.callbacks.onError?.(
        "unconfigured",
        "No batch transcriber available for the configured STT provider",
      );
      return;
    }

    // Transcribe with a timeout, using a session-level abort controller
    // so dispose() can cancel in-flight requests.
    const controller = new AbortController();
    this.activeTranscriptionAbort = controller;
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.transcriptionTimeoutMs,
    );

    try {
      const result = await transcriber.transcribe({
        audio: audioBuffer,
        mimeType: "audio/wav",
        signal: controller.signal,
      });

      if (this.disposed) {
        return;
      }
      this.callbacks.onTranscriptFinal?.(result.text, durationMs);
    } catch (err) {
      if (this.disposed) {
        return;
      }
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
    } finally {
      clearTimeout(timeoutId);
      if (this.activeTranscriptionAbort === controller) {
        this.activeTranscriptionAbort = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stop a streaming transcriber, swallowing best-effort stop failures. */
function stopStreamingBestEffort(
  transcriber: StreamingTranscriber | null,
): void {
  if (!transcriber) {
    return;
  }
  try {
    transcriber.stop();
  } catch (err) {
    log.debug({ error: err }, "Streaming transcriber stop failed");
  }
}
