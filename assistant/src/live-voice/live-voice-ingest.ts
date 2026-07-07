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
 *   finals fire `onTranscriptFinal`. Every locally-detected turn boundary
 *   produces exactly one final: when a turn transcribes to nothing (noise
 *   in open-mic, a speechless PTT press) an empty final is emitted — in
 *   the plain tier when the cycled provider session closes without
 *   flushing a final, in the boundary tier after a short fallback window
 *   with no provider final. Chunks arriving while the provider session is
 *   starting (or restarting between plain-tier turns) are held in a
 *   bounded buffer and flushed on start (overflow drops the oldest chunks
 *   and is counted + logged at teardown); turns that complete during that
 *   gap are batch-transcribed when the settled tier cannot deliver their
 *   finals itself.
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

  /**
   * Boundary-tier streaming only: how long after a local turn boundary
   * to wait for the provider's utterance final before emitting an empty
   * final for the turn. Default:
   * {@link DEFAULT_STREAMING_BOUNDARY_FINAL_TIMEOUT_MS}. Injectable for
   * tests.
   */
  streamingBoundaryFinalTimeoutMs?: number;
}

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10_000;

/** Default bound for the startup chunk buffer. */
const DEFAULT_STREAMING_STARTUP_BUFFER_FRAMES = 500;

/**
 * How long the boundary streaming tier waits after a local turn boundary
 * for the provider's utterance final before concluding the turn carried no
 * transcribable speech and emitting an empty final (which the session
 * layer surfaces as a cancelled turn). Boundary providers emit nothing at
 * all for non-speech noise, so without this fallback a noise-triggered
 * open-mic turn or speechless PTT press would never produce a final and
 * the client would wait out its own backstop. 2s comfortably exceeds
 * typical provider endpointing latency without stalling the client long.
 */
const DEFAULT_STREAMING_BOUNDARY_FINAL_TIMEOUT_MS = 2_000;

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
   * Fires exactly once per locally-detected turn boundary in every mode;
   * text is empty for turns whose audio transcribed to nothing (the
   * session layer cancels such turns). Streaming mode may additionally
   * fire for provider utterance finals that split a local turn.
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
   * queued with their buffered audio. Resolved when the mode settles:
   * batch-transcribed in order when streaming never materializes or the
   * settled tier is `plain` (a plain-tier session is never cycled for an
   * already-ended turn, so its final would merge into the next turn's or
   * never arrive); in a boundary settle the flushed audio produces the
   * finals and each queued turn arms the empty-final fallback.
   */
  private pendingCompletedTurns: { chunks: Buffer[]; durationMs: number }[] =
    [];

  /** Chunks buffered while the streaming transcriber starts up. */
  private startupFrames: Buffer[] = [];

  /** Bound for {@link startupFrames}. */
  private readonly startupBufferFrames: number;

  /** Chunks evicted from the startup buffer on overflow. */
  private startupFramesDroppedCount = 0;

  /**
   * Total chunks pushed into {@link startupFrames} during the current
   * pending window, including chunks since evicted. Reset when the mode
   * settles.
   */
  private startupFramesPushedTotal = 0;

  /**
   * Absolute index (in {@link startupFramesPushedTotal} terms) up to which
   * buffered startup frames belong to turns that already completed while
   * streaming was pending. On a plain-tier settle those turns are
   * batch-transcribed from {@link pendingCompletedTurns}, so their frames
   * are excluded from the flush (no double transcription).
   */
  private startupFramesCompletedTurnsMark = 0;

  /** Whether the startup-drop metric has been logged at teardown. */
  private startupDropsLogged = false;

  /** Speech-bearing audio milliseconds since the last streaming final. */
  private utteranceAudioMs = 0;

  /**
   * Tail of {@link batchTurnQueue} that streaming-path finals must not
   * overtake. Set when a plain-tier settle routes pending completed turns
   * through the batch queue: their finals must reach the session before
   * finals of later streaming turns, so streaming finals chain behind the
   * queue until it drains. `null` when no ordering hold is active.
   */
  private streamingFinalsGate: Promise<void> | null = null;

  /** Boundary-tier empty-final fallback window (see config). */
  private readonly boundaryFinalTimeoutMs: number;

  /**
   * Boundary tier: local turn boundaries still awaiting a provider
   * utterance final, oldest first. Each entry is resolved by the next
   * non-empty provider final, or emits an empty final when
   * {@link boundaryFinalTimer} fires.
   */
  private boundaryTurnsAwaitingFinal: { durationMs: number }[] = [];

  /**
   * Boundary tier: non-empty provider finals that arrived before their
   * local turn boundary (provider endpointing typically beats the local
   * silence threshold). Each one satisfies the next boundary so no empty
   * final follows a turn that already has a real transcript. Reset at
   * each turn start — a final never precedes its own turn's audio, so an
   * unmatched early final at a new turn's onset belongs to a prior turn.
   */
  private earlyBoundaryFinalsCount = 0;

  /** Timer backing the boundary-tier empty-final fallback. */
  private boundaryFinalTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Plain tier: the per-turn stop-cycle whose forced end-of-stream final
   * is still outstanding. If the stopped session closes without flushing
   * a non-empty final, an empty final is emitted for the turn so every
   * turn boundary yields exactly one final.
   */
  private plainForcedFinal: {
    source: StreamingTranscriber;
    durationMs: number;
    /** A final (real or empty) has been emitted for this turn. */
    settled: boolean;
    /** The empty fallback was emitted — drop the source's late finals. */
    emittedEmpty: boolean;
    /**
     * Set when a later turn settled onto the batch queue while this final
     * was still outstanding
     * ({@link chainBatchQueueBehindOutstandingForcedFinal}): resolution
     * delivers the text (real final, or `""` for the empty fallback) here
     * instead of emitting directly, so the queued placeholder emits it in
     * turn order ahead of the younger turns.
     */
    deliver?: (text: string) => void;
  } | null = null;

  /**
   * Whether the live streaming session already emitted a non-empty final
   * attributable to the current turn (plain-tier providers may commit
   * segment finals mid-turn). Suppresses the empty fallback for that
   * turn's stop-cycle. Reset per plain-tier cycle and on settle.
   */
  private liveSessionEmittedFinal = false;

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
    this.boundaryFinalTimeoutMs =
      config.streamingBoundaryFinalTimeoutMs ??
      DEFAULT_STREAMING_BOUNDARY_FINAL_TIMEOUT_MS;
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
          // See earlyBoundaryFinalsCount: unmatched early finals at a new
          // turn's onset belong to prior turns and must not suppress this
          // turn's empty-final fallback.
          this.earlyBoundaryFinalsCount = 0;
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
    // The session layer is tearing down: an empty fallback final after
    // onStop would be noise, so cancel any pending boundary fallback.
    this.clearBoundaryFinalFallback();
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
    this.clearBoundaryFinalFallback();
    // Release a queue placeholder waiting on the forced final (the
    // placeholder's own disposed check suppresses the emission).
    this.plainForcedFinal?.deliver?.("");
    this.plainForcedFinal = null;
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
    this.liveSessionEmittedFinal = false;

    // Flush audio buffered while the provider session was starting. Turns
    // that already COMPLETED during the gap need per-tier handling:
    // - boundary: flush their audio too — the provider emits their
    //   utterance finals — but arm the empty-final fallback per turn so a
    //   noise-only turn still resolves.
    // - plain: the new session is never cycled for an already-ended turn
    //   (its final would merge into the next turn's forced final, or
    //   never arrive), so batch-transcribe the completed turns from their
    //   captured chunks and exclude their frames from the flush. Turns
    //   still in progress keep flowing into the new session.
    const pending = this.pendingCompletedTurns;
    this.pendingCompletedTurns = [];
    let buffered = this.startupFrames;
    this.startupFrames = [];
    if (pending.length > 0) {
      if (tier === "plain") {
        const evictedFrames = this.startupFramesPushedTotal - buffered.length;
        buffered = buffered.slice(
          Math.max(0, this.startupFramesCompletedTurnsMark - evictedFrames),
        );
        log.info(
          { turnCount: pending.length },
          "Batch-transcribing turns completed during plain-tier streaming startup",
        );
        // The previous turn's forced final may still be outstanding (its
        // stopped session flushes asynchronously): its final must enter
        // the queue before these younger turns' batch finals.
        this.chainBatchQueueBehindOutstandingForcedFinal();
        for (const { chunks, durationMs } of pending) {
          this.enqueueTurnTranscription(chunks, durationMs);
        }
        // Their finals are now in flight on the batch queue — hold later
        // streaming finals behind it so turn order is preserved.
        this.holdStreamingFinalsBehindBatchQueue();
      } else {
        for (const { durationMs } of pending) {
          this.armBoundaryFinalFallback(durationMs);
        }
      }
    }
    this.startupFramesPushedTotal = 0;
    this.startupFramesCompletedTurnsMark = 0;

    for (const frame of buffered) {
      transcriber.sendAudio(frame, this.streamingMimeType);
    }

    // The batch fallback is settled — drop its turn buffer.
    this.currentTurnChunks = [];
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
    this.startupFramesPushedTotal = 0;
    this.startupFramesCompletedTurnsMark = 0;

    // A plain-tier turn's forced final may still be outstanding (e.g. the
    // restart's resolution failed into this recovery). Every batch-mode
    // final flows through the serialized queue, so chaining once here
    // keeps the outstanding older final ahead of all of them.
    this.chainBatchQueueBehindOutstandingForcedFinal();

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
      case "final":
        this.handleStreamingFinal(event.text.trim(), source);
        return;
      case "error":
        this.callbacks.onError?.(event.category, event.message);
        return;
      case "closed":
        // A stopped plain-tier session closing without having flushed a
        // non-empty final: the turn transcribed to nothing — emit the
        // empty final so the session layer can cancel the turn.
        if (this.plainForcedFinal?.source === source) {
          this.settlePlainForcedFinalEmpty();
        }
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
   * Handle a `final` event from a streaming transcriber session.
   *
   * Finals flushed by a stopped plain-tier session belong to the turn
   * whose boundary forced the stop ({@link plainForcedFinal}); finals from
   * the live session belong to the current turn. Empty provider finals
   * never emit directly — empty-turn signaling flows through the per-tier
   * fallbacks (plain: session close; boundary: the fallback timer; batch:
   * per-turn transcription) so each boundary yields exactly one final.
   */
  private handleStreamingFinal(
    text: string,
    source: StreamingTranscriber,
  ): void {
    const forced = this.plainForcedFinal;
    if (
      forced !== null &&
      forced.source === source &&
      source !== this.streamingTranscriber
    ) {
      if (forced.emittedEmpty) {
        // The empty fallback already resolved this turn — a late real
        // final would be a second final for the same boundary.
        return;
      }
      if (text.length === 0) {
        return; // the closed handler emits the empty fallback
      }
      forced.settled = true;
      if (forced.deliver) {
        forced.deliver(text);
      } else {
        this.emitStreamingFinal(text, forced.durationMs);
      }
      return;
    }

    if (text.length === 0) {
      return;
    }

    const durationMs = Math.round(this.utteranceAudioMs);
    this.utteranceAudioMs = 0;
    if (source === this.streamingTranscriber) {
      this.liveSessionEmittedFinal = true;
      if (this.streamingTier === "boundary") {
        this.matchBoundaryFinal();
      }
    }
    this.emitStreamingFinal(text, durationMs);
  }

  /**
   * Emit a streaming-path final (possibly empty), deferring behind the
   * batch queue while {@link streamingFinalsGate} holds — finals of turns
   * completed during a plain-tier startup gap are in flight there and
   * must reach the session first.
   */
  private emitStreamingFinal(text: string, durationMs: number): void {
    if (this.streamingFinalsGate === null) {
      this.callbacks.onTranscriptFinal?.(text, durationMs);
      return;
    }
    this.batchTurnQueue = this.batchTurnQueue.then(() => {
      if (!this.disposed) {
        this.callbacks.onTranscriptFinal?.(text, durationMs);
      }
    });
    // Extend the gate to the new tail so deferred finals stay ordered
    // among themselves too.
    this.holdStreamingFinalsBehindBatchQueue();
  }

  /**
   * Hold streaming-path finals behind the current tail of the batch queue
   * until it drains (see {@link streamingFinalsGate}).
   */
  private holdStreamingFinalsBehindBatchQueue(): void {
    const gate = this.batchTurnQueue;
    this.streamingFinalsGate = gate;
    void gate.then(() => {
      if (this.streamingFinalsGate === gate) {
        this.streamingFinalsGate = null;
      }
    });
  }

  /**
   * Force the just-ended turn's utterance final in the plain streaming
   * tier: stop the provider session (plain-tier providers flush their
   * final at end-of-stream — V1's ptt_release did exactly this) and start
   * a fresh session for the next turn, reusing the startup-buffer
   * machinery so no audio is lost in the restart gap.
   *
   * The stopped session is recorded in {@link plainForcedFinal}: if it
   * closes without flushing a non-empty final, the turn transcribed to
   * nothing and an empty final is emitted in its place.
   *
   * @param durationMs - Duration of the turn that just ended, reported
   *   with its forced (or empty) final.
   */
  private async restartPlainStreamingForNextTurn(
    durationMs: number,
  ): Promise<void> {
    const transcriber = this.streamingTranscriber;
    this.streamingTranscriber = null;
    this.mode = "streaming-pending";
    // The previous cycle's session should have settled by now; if it
    // never closed, resolve its turn empty before this turn's final can
    // emit (finals stay in boundary order).
    this.settlePlainForcedFinalEmpty();
    if (transcriber === null) {
      // No session to flush a final from — the turn transcribed to nothing.
      this.plainForcedFinal = null;
      this.emitStreamingFinal("", durationMs);
    } else {
      this.plainForcedFinal = {
        source: transcriber,
        durationMs,
        // Mid-turn segment finals already gave this turn a transcript.
        settled: this.liveSessionEmittedFinal,
        emittedEmpty: false,
      };
    }
    this.liveSessionEmittedFinal = false;
    this.utteranceAudioMs = 0;
    stopStreamingBestEffort(transcriber);
    await this.startStreaming();
  }

  /**
   * Emit the empty fallback final for an unsettled plain-tier stop-cycle
   * (see {@link plainForcedFinal}). No-op when the turn already settled.
   */
  private settlePlainForcedFinalEmpty(): void {
    const forced = this.plainForcedFinal;
    if (forced === null || forced.settled) {
      return;
    }
    forced.settled = true;
    forced.emittedEmpty = true;
    if (forced.deliver) {
      forced.deliver("");
    } else {
      this.emitStreamingFinal("", forced.durationMs);
    }
  }

  /**
   * If the previous plain-tier stop-cycle's forced final is still
   * outstanding (the stopped session flushes its end-of-stream final
   * asynchronously), claim it onto the batch queue ahead of whatever is
   * enqueued next: the final — real, or the empty fallback when the
   * stopped session closes without one — is delivered from the queue, so
   * a younger turn routed through the queue can never overtake it. The
   * placeholder is bounded by the same signals that settle every forced
   * final: the stopped session's `final`/`closed` events, the next
   * restart's settle, or {@link dispose}.
   */
  private chainBatchQueueBehindOutstandingForcedFinal(): void {
    const forced = this.plainForcedFinal;
    if (forced === null || forced.settled || forced.deliver) {
      return;
    }
    const delivered = new Promise<string>((resolve) => {
      forced.deliver = resolve;
    });
    this.batchTurnQueue = this.batchTurnQueue.then(async () => {
      const text = await delivered;
      if (!this.disposed) {
        this.callbacks.onTranscriptFinal?.(text, forced.durationMs);
      }
    });
  }

  // ── Boundary-tier empty-final fallback ─────────────────────────────

  /**
   * Boundary tier: a local turn boundary fired — expect a provider
   * utterance final for it within {@link boundaryFinalTimeoutMs}, or emit
   * an empty final so the turn still resolves (boundary providers emit
   * nothing at all for non-speech noise).
   */
  private armBoundaryFinalFallback(durationMs: number): void {
    if (this.earlyBoundaryFinalsCount > 0) {
      // The provider's final for this turn already arrived (its
      // endpointing beat the local silence threshold) — never emit an
      // empty final after a real one for the same turn.
      this.earlyBoundaryFinalsCount -= 1;
      return;
    }
    this.boundaryTurnsAwaitingFinal.push({ durationMs });
    this.restartBoundaryFinalTimer();
  }

  /**
   * Boundary tier: a non-empty live final arrived — it resolves the
   * oldest boundary still awaiting one (finals for turn N may land after
   * turn N+1 started), or counts as an early final for the current turn.
   */
  private matchBoundaryFinal(): void {
    if (this.boundaryTurnsAwaitingFinal.length === 0) {
      this.earlyBoundaryFinalsCount += 1;
      return;
    }
    this.boundaryTurnsAwaitingFinal.shift();
    if (this.boundaryTurnsAwaitingFinal.length === 0) {
      this.clearBoundaryFinalFallback();
    } else {
      // Give the remaining boundaries a fresh window.
      this.restartBoundaryFinalTimer();
    }
  }

  /** (Re-)arm the boundary-tier fallback timer. */
  private restartBoundaryFinalTimer(): void {
    if (this.boundaryFinalTimer !== null) {
      clearTimeout(this.boundaryFinalTimer);
    }
    this.boundaryFinalTimer = setTimeout(() => {
      this.boundaryFinalTimer = null;
      const awaiting = this.boundaryTurnsAwaitingFinal;
      this.boundaryTurnsAwaitingFinal = [];
      for (const { durationMs } of awaiting) {
        this.emitStreamingFinal("", durationMs);
      }
    }, this.boundaryFinalTimeoutMs);
  }

  /** Cancel the boundary-tier fallback timer and drop awaiting boundaries. */
  private clearBoundaryFinalFallback(): void {
    if (this.boundaryFinalTimer !== null) {
      clearTimeout(this.boundaryFinalTimer);
      this.boundaryFinalTimer = null;
    }
    this.boundaryTurnsAwaitingFinal = [];
  }

  /**
   * Append a chunk to the bounded startup buffer. On overflow the oldest
   * chunk is dropped and counted; the total is logged at teardown.
   */
  private bufferStartupFrame(chunk: Buffer): void {
    this.startupFrames.push(chunk);
    this.startupFramesPushedTotal += 1;
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
    // queued with their captured audio so the settle path can resolve
    // them (batch fallback, plain-tier batch routing, or the boundary
    // tier's flushed-audio finals + empty-final fallback).
    if (this.mode !== "batch") {
      if (this.mode === "streaming-pending") {
        const chunks = this.currentTurnChunks;
        this.currentTurnChunks = [];
        this.pendingCompletedTurns.push({ chunks, durationMs });
        this.startupFramesCompletedTurnsMark = this.startupFramesPushedTotal;
        return;
      }
      if (this.deliberateStop) {
        // stop() flushes any trailing final by stopping the live session
        // directly; the session layer is tearing down.
        return;
      }
      if (this.streamingTier === "plain") {
        // Plain-tier streaming never emits an utterance-boundary final on
        // its own — force it by cycling the provider session.
        void this.restartPlainStreamingForNextTurn(durationMs);
      } else {
        // Boundary tier: the provider emits the final itself — but not
        // for noise-only turns, so arm the empty-final fallback.
        this.armBoundaryFinalFallback(durationMs);
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
