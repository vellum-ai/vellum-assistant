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
 *   provider with utterance-boundary finals. Partials are forwarded via
 *   `onPartial` (the in-app UI displays live transcripts); non-empty finals
 *   fire `onTranscriptFinal`. Chunks arriving while the provider session is
 *   still starting are held in a bounded buffer and flushed on start
 *   (overflow drops the oldest chunks and is counted + logged at teardown).
 * - **Batch** — segmented audio turns are wrapped in a WAV container and
 *   transcribed per turn via the batch transcriber. Used when no streaming
 *   transcriber is available for the configured provider or the provider
 *   closed the streaming session unexpectedly mid-session.
 *
 * Speech-start (`onSpeechStart`) and turn boundaries (`onTurnBoundary`)
 * always come from the local VAD/turn detector, never from transcriber
 * events — the session layer decides what they mean (barge-in in open-mic,
 * informational in PTT).
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

  /** Microphone mode the session negotiated (informational for the ingest). */
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
        silenceThresholdMs: config.vad.silenceThresholdMs,
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
          void this.handleTurnEnd(durationMs);
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
   * End the current utterance immediately — the PTT release path.
   *
   * Flushes the turn detector: in batch mode the buffered turn is
   * transcribed now; in streaming mode the provider's utterance-boundary
   * finals deliver the transcript.
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
    this.turnDetector.forceEnd();
    this.deliberateStop = true;
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
   * Resolve and start the streaming transcriber, then flush the chunks
   * buffered during startup. Falls back to the batch path when no
   * streaming transcriber is available or the provider session cannot be
   * established — the mode is settled before streaming ever becomes
   * active, so modes are never mixed mid-session.
   */
  private async startStreaming(): Promise<void> {
    let transcriber: StreamingTranscriber | null = null;
    try {
      transcriber = await this.resolveStreaming({
        sampleRate: this.config.sampleRate,
        utteranceBoundaryFinals: true,
      });
    } catch (err) {
      log.warn(
        { error: err },
        "Streaming transcriber resolution failed — falling back to batch STT",
      );
    }

    if (this.disposed) {
      stopStreamingBestEffort(transcriber);
      return;
    }

    if (!transcriber) {
      this.enterBatchMode();
      return;
    }

    try {
      await transcriber.start((event) => this.handleStreamingEvent(event));
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

    if (this.disposed) {
      stopStreamingBestEffort(transcriber);
      return;
    }

    this.streamingTranscriber = transcriber;
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
      void (async () => {
        for (const { chunks, durationMs } of pending) {
          await this.transcribeTurn(chunks, durationMs);
        }
      })();
    }
  }

  /**
   * Map streaming transcriber events onto the ingest callbacks.
   *
   * Partials are forwarded (the in-app UI displays live transcripts) but
   * never drive turn-taking: turn boundaries come from the local VAD and
   * transcripts commit on the provider's utterance-boundary finals.
   */
  private handleStreamingEvent(event: SttStreamServerEvent): void {
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

  private async handleTurnEnd(durationMs: number): Promise<void> {
    // Streaming modes take transcripts from the provider's
    // utterance-boundary finals, not the local VAD. Turns completed
    // while streaming is still pending are queued so a later batch
    // fallback can transcribe their buffered audio.
    if (this.mode !== "batch") {
      if (this.mode === "streaming-pending") {
        const chunks = this.currentTurnChunks;
        this.currentTurnChunks = [];
        if (chunks.length > 0) {
          this.pendingCompletedTurns.push({ chunks, durationMs });
        }
      }
      return;
    }

    const chunks = this.currentTurnChunks;
    this.currentTurnChunks = [];

    if (chunks.length === 0) {
      // Silence turn — no audio to transcribe.
      this.callbacks.onTranscriptFinal?.("", durationMs);
      return;
    }

    await this.transcribeTurn(chunks, durationMs);
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
