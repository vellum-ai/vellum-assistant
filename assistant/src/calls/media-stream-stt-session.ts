/**
 * STT session module for media-stream call ingestion.
 *
 * Transcribes inbound caller audio in one of two modes, selected at the
 * `start` event (streaming additionally falls back to batch if the
 * provider closes the stream mid-call):
 *
 * - **Streaming** (default, `calls.voice.telephonyStreaming: true`) —
 *   inbound mu-law audio is decoded to 16 kHz PCM16 and fed to a
 *   {@link StreamingTranscriber} resolved for the configured
 *   `services.stt` provider. Replies trigger on the provider's
 *   utterance-boundary `final` events; barge-in (`onSpeechStart`) always
 *   fires from the local energy VAD, never from transcriber partials.
 *   Frames arriving while the provider session is still starting are
 *   held in a bounded buffer and flushed on start (overflow drops the
 *   oldest frames and is counted + logged at teardown).
 * - **Batch** — segmented audio turns (produced by
 *   {@link MediaTurnDetector}) are transcribed per turn via the batch
 *   transcriber. Used when the streaming flag is off, no streaming
 *   transcriber is available for the configured provider, or the
 *   provider closed the streaming session unexpectedly mid-call.
 *
 * This module is **transport-neutral** — it exposes callback hooks
 * (`onSpeechStart`, `onTranscriptFinal`, `onDtmf`, `onStop`) rather than
 * driving any call flow itself; `media-stream-server.ts` instantiates and
 * connects it to the media-stream WebSocket ingress.
 *
 * Error handling:
 * - When the telephony resolver returns a non-supported status, the
 *   session reports the failure through `onError` and stops processing.
 * - Individual turn transcription failures (timeouts, provider errors)
 *   are reported through `onError` without tearing down the session.
 * - Streaming transcriber errors are reported through `onError` with the
 *   provider's normalized category.
 */

import { getConfig } from "../config/loader.js";
import {
  resolveBatchTranscriber,
  resolveStreamingTranscriber,
  resolveTelephonySttCapability,
  type TelephonySttCapability,
} from "../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../stt/daemon-batch-transcriber.js";
import type {
  StreamingTranscriber,
  SttCallContextHints,
  SttStreamServerEvent,
} from "../stt/types.js";
import { getLogger } from "../util/logger.js";
import {
  mulawToLinear,
  mulawToPcm16,
  resamplePcm16,
} from "./media-stream-audio-transcode.js";
import { parseMediaStreamFrame } from "./media-stream-parser.js";
import type {
  MediaStreamMediaEvent,
  MediaStreamStartEvent,
} from "./media-stream-protocol.js";
import {
  MediaTurnDetector,
  type TurnDetectorConfig,
} from "./media-turn-detector.js";

const log = getLogger("media-stt-session");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MediaStreamSttSessionConfig {
  /** Overrides for the turn detector thresholds. */
  turnDetector?: TurnDetectorConfig;

  /** Per-request transcription timeout in milliseconds. Default: 10_000. */
  transcriptionTimeoutMs?: number;

  /** Optional call-context hints forwarded to the STT provider. */
  callContextHints?: SttCallContextHints;

  /**
   * Maximum number of media frames buffered while the streaming
   * transcriber starts up. Default: 500 (~10 s of 20 ms frames).
   */
  streamingStartupBufferFrames?: number;
}

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10_000;

/** Twilio media streams deliver 8 kHz mono mu-law audio. */
const TELEPHONY_SOURCE_SAMPLE_RATE = 8_000;

/** Sample rate expected by the daemon streaming transcribers. */
const STREAMING_SAMPLE_RATE = 16_000;

/** MIME type for the PCM16 frames fed to the streaming transcriber. */
const STREAMING_AUDIO_MIME_TYPE = `audio/pcm;rate=${STREAMING_SAMPLE_RATE}`;

/** Default bound for the startup frame buffer (~10 s of 20 ms frames). */
const DEFAULT_STREAMING_STARTUP_BUFFER_FRAMES = 500;

/**
 * Transcription mode, selected at the `start` event:
 * - `"batch"` — per-turn batch transcription via {@link MediaTurnDetector}.
 * - `"streaming-pending"` — streaming selected; provider session still
 *   starting, frames buffered.
 * - `"streaming"` — live streaming session active. Falls back to
 *   `"batch"` if the provider closes the stream unexpectedly mid-call.
 */
type SttSessionMode = "batch" | "streaming-pending" | "streaming";

// ---------------------------------------------------------------------------
// Callback hooks
// ---------------------------------------------------------------------------

export interface MediaStreamSttSessionCallbacks {
  /** Called when the turn detector transitions to active (first speech-bearing chunk). */
  onSpeechStart?: () => void;

  /**
   * Called when a completed caller utterance has been transcribed.
   *
   * Batch mode: fires per detected turn; text may be empty for silence
   * turns. Streaming mode: fires per utterance-boundary final from the
   * provider; empty finals are suppressed.
   *
   * @param text - The transcribed text (trimmed).
   * @param durationMs - Approximate duration of the audio turn.
   */
  onTranscriptFinal?: (text: string, durationMs: number) => void;

  /**
   * Called when a DTMF digit is received from Twilio.
   */
  onDtmf?: (digit: string) => void;

  /**
   * Called when the media stream stops.
   */
  onStop?: () => void;

  /**
   * Called when an error occurs (provider error, timeout, no-provider, etc.).
   *
   * @param category - A structured error category.
   * @param message - Human-readable description.
   */
  onError?: (category: string, message: string) => void;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class MediaStreamSttSession {
  private readonly config: MediaStreamSttSessionConfig;
  private readonly callbacks: MediaStreamSttSessionCallbacks;
  private readonly turnDetector: MediaTurnDetector;
  private readonly transcriptionTimeoutMs: number;

  /** Buffer of base64-encoded audio payloads for the current turn. */
  private currentTurnChunks: string[] = [];

  /** Stream metadata from the `start` event. */
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private encoding: string | null = null;

  /** Whether the session has been disposed. */
  private disposed = false;

  /** Capability snapshot — resolved lazily on first turn end. */
  private capabilityPromise: Promise<TelephonySttCapability> | null = null;

  /** Session-level abort controller for the active transcription request. */
  private activeTranscriptionAbort: AbortController | null = null;

  /** Transcription mode — selected once in {@link handleStart}. */
  private mode: SttSessionMode = "batch";

  /** Live streaming transcriber (streaming mode only). */
  private streamingTranscriber: StreamingTranscriber | null = null;

  /**
   * Whether the session deliberately stopped the streaming transcriber
   * (stream `stop` event or dispose). Distinguishes expected `closed`
   * events from provider-initiated closes, which trigger batch fallback.
   */
  private deliberateStreamingStop = false;

  /**
   * Turns the local VAD completed while the mode was `streaming-pending`,
   * queued with their buffered audio. {@link enterBatchMode} transcribes
   * them in order if streaming never materializes. Cleared when streaming
   * settles active and on dispose.
   */
  private pendingCompletedTurns: { chunks: string[]; durationMs: number }[] =
    [];

  /** PCM16 frames buffered while the streaming transcriber starts up. */
  private startupFrames: Buffer[] = [];

  /** Bound for {@link startupFrames}. */
  private readonly startupBufferFrames: number;

  /** Frames evicted from the startup buffer on overflow. */
  private startupFramesDroppedCount = 0;

  /** Whether the startup-drop metric has been logged at teardown. */
  private startupDropsLogged = false;

  /** Speech-bearing audio milliseconds since the last streaming final. */
  private utteranceAudioMs = 0;

  constructor(
    config: MediaStreamSttSessionConfig = {},
    callbacks: MediaStreamSttSessionCallbacks = {},
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.transcriptionTimeoutMs =
      config.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
    this.startupBufferFrames =
      config.streamingStartupBufferFrames ??
      DEFAULT_STREAMING_STARTUP_BUFFER_FRAMES;

    this.turnDetector = new MediaTurnDetector(config.turnDetector, {
      onTurnStart: () => {
        // Clear inter-turn silence that accumulated while idle so each
        // transcription request contains only speech-relevant chunks.
        this.currentTurnChunks = [];
        this.callbacks.onSpeechStart?.();
      },
      onTurnEnd: (reason, durationMs) => {
        void this.handleTurnEnd(reason, durationMs);
      },
    });
  }

  /**
   * Feed a raw WebSocket message into the session. The message is parsed,
   * validated, and routed to the appropriate handler.
   */
  handleMessage(raw: string): void {
    if (this.disposed) return;

    const result = parseMediaStreamFrame(raw);
    if (!result.ok) {
      log.debug({ error: result.error }, "Dropped malformed media frame");
      return;
    }

    const event = result.event;
    switch (event.event) {
      case "start":
        this.handleStart(event);
        break;
      case "media":
        this.handleMedia(event);
        break;
      case "dtmf":
        this.callbacks.onDtmf?.(event.dtmf.digit);
        break;
      case "mark":
        // Marks are informational — no action needed in the STT session.
        break;
      case "stop":
        this.handleStop();
        break;
    }
  }

  /**
   * Dispose of the session, clearing all timers and buffers and stopping
   * any active streaming transcriber.
   */
  dispose(): void {
    this.disposed = true;
    this.deliberateStreamingStop = true;
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

  /** Frames dropped from the bounded streaming startup buffer. */
  get streamingStartupFramesDropped(): number {
    return this.startupFramesDroppedCount;
  }

  // ── Event handlers ─────────────────────────────────────────────────

  private handleStart(event: MediaStreamStartEvent): void {
    this.streamSid = event.streamSid;
    this.callSid = event.start.callSid;
    this.encoding = event.start.mediaFormat.encoding;

    const streamingEnabled = getConfig().calls.voice.telephonyStreaming;

    log.info(
      {
        streamSid: this.streamSid,
        callSid: this.callSid,
        encoding: this.encoding,
        sampleRate: event.start.mediaFormat.sampleRate,
        telephonyStreaming: streamingEnabled,
      },
      "Media stream STT session started",
    );

    if (streamingEnabled) {
      this.mode = "streaming-pending";
      void this.startStreaming();
      return;
    }

    this.enterBatchMode();
  }

  private handleMedia(event: MediaStreamMediaEvent): void {
    // Only process inbound (caller) audio
    if (event.media.track !== "inbound") return;

    // Compute speech activity from the audio payload using a lightweight
    // energy heuristic. mu-law encoded audio has a companded dynamic
    // range — silence sits near 0xFF/0x7F while speech has higher energy.
    //
    // The detector call runs BEFORE the push so that the onTurnStart
    // callback can clear stale inter-turn silence from the buffer
    // without also wiping the first speech chunk of the new turn.
    //
    // The detector runs in every mode: in streaming mode it only drives
    // barge-in (`onSpeechStart` fires from this local VAD, never from
    // transcriber partials).
    const raw = Buffer.from(event.media.payload, "base64");
    const hasSpeech = detectSpeechActivity(raw);
    this.turnDetector.onMediaChunk(hasSpeech);

    if (this.mode === "batch") {
      this.currentTurnChunks.push(event.media.payload);
      return;
    }

    // Approximate the utterance duration reported with streaming finals:
    // count audio while the local VAD sees an active turn.
    if (hasSpeech || this.turnDetector.isActive) {
      this.utteranceAudioMs +=
        raw.length / (TELEPHONY_SOURCE_SAMPLE_RATE / 1000);
    }

    const pcm = resamplePcm16(
      mulawToPcm16(raw),
      TELEPHONY_SOURCE_SAMPLE_RATE,
      STREAMING_SAMPLE_RATE,
    );

    if (this.mode === "streaming") {
      this.streamingTranscriber?.sendAudio(pcm, STREAMING_AUDIO_MIME_TYPE);
      return;
    }

    // streaming-pending: the provider session is still starting. Buffer
    // the PCM for the flush, and keep filling the turn buffer so a batch
    // fallback still has the audio.
    this.bufferStartupFrame(pcm);
    this.currentTurnChunks.push(event.media.payload);
  }

  private handleStop(): void {
    // Finalize any in-flight turn
    this.turnDetector.forceEnd();
    // Streaming: signal end-of-audio so the provider flushes any withheld
    // utterance text as a trailing final before closing.
    this.deliberateStreamingStop = true;
    stopStreamingBestEffort(this.streamingTranscriber);
    this.logStartupDrops();
    this.callbacks.onStop?.();
  }

  // ── Streaming mode ─────────────────────────────────────────────────

  /**
   * Resolve and start the streaming transcriber, then flush the frames
   * buffered during startup. Falls back to the batch path when no
   * streaming transcriber is available or the provider session cannot be
   * established — the mode is settled before streaming ever becomes
   * active, so modes are never mixed mid-session.
   */
  private async startStreaming(): Promise<void> {
    let transcriber: StreamingTranscriber | null = null;
    try {
      transcriber = await resolveStreamingTranscriber({
        sampleRate: STREAMING_SAMPLE_RATE,
        utteranceBoundaryFinals: true,
      });
    } catch (err) {
      log.warn(
        { error: err, streamSid: this.streamSid },
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
        { error: err, streamSid: this.streamSid },
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
      transcriber.sendAudio(frame, STREAMING_AUDIO_MIME_TYPE);
    }

    // The batch fallback is settled — drop its turn buffers.
    this.currentTurnChunks = [];
    this.pendingCompletedTurns = [];
  }

  /**
   * Settle on the batch path: clear streaming startup state and eagerly
   * resolve the telephony capability so it's cached by the time the
   * first turn completes.
   *
   * Turns the local VAD already completed while streaming was pending
   * are stranded — {@link handleTurnEnd} deferred them to streaming
   * finals that will never arrive — so the queue is batch-transcribed
   * here in order. This recovery applies only to the pending path: on a
   * mid-call provider close, an in-progress turn's earlier audio already
   * went to the dead provider, and only audio arriving after the
   * fallback is batch-transcribed.
   */
  private enterBatchMode(): void {
    this.mode = "batch";
    this.startupFrames = [];
    this.capabilityPromise ??= resolveTelephonySttCapability();

    const pending = this.pendingCompletedTurns;
    this.pendingCompletedTurns = [];
    if (pending.length > 0) {
      log.info(
        { streamSid: this.streamSid, turnCount: pending.length },
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
   * Map streaming transcriber events onto the session callbacks.
   *
   * Partials are ignored for turn-taking: replies trigger only on the
   * provider's utterance-boundary finals, and barge-in comes from the
   * local VAD.
   */
  private handleStreamingEvent(event: SttStreamServerEvent): void {
    if (this.disposed) {
      return;
    }

    switch (event.type) {
      case "partial":
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
        // Provider-initiated close mid-call: without a live transcriber
        // the streaming mode would silently drop all subsequent audio.
        // Fall back to per-turn batch transcription (the local VAD/turn
        // detector already runs in streaming mode).
        if (this.mode === "streaming" && !this.deliberateStreamingStop) {
          log.warn(
            { streamSid: this.streamSid, callSid: this.callSid },
            "Streaming transcriber closed unexpectedly mid-call — falling back to batch STT",
          );
          this.enterBatchMode();
        }
        return;
    }
  }

  /**
   * Append a decoded frame to the bounded startup buffer. On overflow the
   * oldest frame is dropped and counted; the total is logged at teardown.
   */
  private bufferStartupFrame(pcm: Buffer): void {
    this.startupFrames.push(pcm);
    if (this.startupFrames.length > this.startupBufferFrames) {
      this.startupFrames.shift();
      this.startupFramesDroppedCount++;
    }
  }

  /** Log the startup-buffer drop count once, if any frames were dropped. */
  private logStartupDrops(): void {
    if (this.startupDropsLogged || this.startupFramesDroppedCount === 0) {
      return;
    }
    this.startupDropsLogged = true;
    log.warn(
      {
        streamingStartupFramesDropped: this.startupFramesDroppedCount,
        streamSid: this.streamSid,
      },
      "Dropped media frames during streaming transcriber startup",
    );
  }

  // ── Turn completion ────────────────────────────────────────────────

  private async handleTurnEnd(
    _reason: "silence" | "max-duration",
    durationMs: number,
  ): Promise<void> {
    // Streaming modes take turn boundaries from the transcriber's
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
    chunks: string[],
    durationMs: number,
  ): Promise<void> {
    // Resolve telephony capability (cached after first call)
    if (!this.capabilityPromise) {
      this.capabilityPromise = resolveTelephonySttCapability();
    }
    const capability = await this.capabilityPromise;
    if (this.disposed) return;

    if (capability.status !== "supported") {
      const reason =
        capability.status === "unsupported"
          ? capability.reason
          : capability.status === "unconfigured"
            ? capability.reason
            : capability.status === "missing-credentials"
              ? capability.reason
              : "Unknown STT capability status";

      this.callbacks.onError?.(capability.status, reason);
      return;
    }

    // Decode the base64 audio chunks into a single buffer.
    const rawAudio = this.decodeAudioChunks(chunks);

    // Wrap raw μ-law PCM in a WAV container so downstream transcribers
    // (e.g. Whisper) receive a recognised audio format with correct headers.
    const isMulaw = this.encoding === "audio/x-mulaw";
    const audioBuffer = isMulaw ? wrapMulawWav(rawAudio) : rawAudio;
    const mimeType = isMulaw ? "audio/wav" : "audio/raw";

    // Resolve a batch transcriber for the configured provider.
    let transcriber;
    try {
      transcriber = await resolveBatchTranscriber();
    } catch (err) {
      if (this.disposed) return;
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
      return;
    }
    if (this.disposed) return;

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
        mimeType,
        signal: controller.signal,
        callContext: this.config.callContextHints,
      });

      if (this.disposed) return;
      this.callbacks.onTranscriptFinal?.(result.text, durationMs);
    } catch (err) {
      if (this.disposed) return;
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
    } finally {
      clearTimeout(timeoutId);
      if (this.activeTranscriptionAbort === controller) {
        this.activeTranscriptionAbort = null;
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Decode an array of base64-encoded audio chunks into a single Buffer.
   */
  private decodeAudioChunks(chunks: string[]): Buffer {
    const buffers = chunks.map((chunk) => Buffer.from(chunk, "base64"));
    return Buffer.concat(buffers);
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

// ---------------------------------------------------------------------------
// Speech activity detection
// ---------------------------------------------------------------------------

/**
 * Lightweight energy-based speech activity detector for mu-law encoded audio.
 *
 * mu-law encoding compands the dynamic range so that silence values cluster
 * around 0xFF (negative zero) and 0x7F (positive zero). Speech produces
 * samples with lower byte values (higher decoded amplitude).
 *
 * This function computes the average absolute G.711-decoded amplitude of
 * the mu-law samples and compares it against a threshold. The threshold is
 * tuned for Twilio's 8 kHz, 8-bit mu-law stream where typical silence
 * averages ~200-400 and speech >1200 on the full 16-bit linear scale.
 *
 * @param raw - Decoded mu-law audio chunk from Twilio.
 * @returns `true` if the chunk likely contains speech, `false` otherwise.
 */
function detectSpeechActivity(raw: Buffer): boolean {
  const SPEECH_ENERGY_THRESHOLD = 800;

  if (raw.length === 0) {
    return false;
  }

  // Compute average absolute linear amplitude from mu-law samples.
  let totalAmplitude = 0;
  for (let i = 0; i < raw.length; i++) {
    totalAmplitude += Math.abs(mulawToLinear(raw[i]));
  }
  const avgAmplitude = totalAmplitude / raw.length;

  return avgAmplitude > SPEECH_ENERGY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// WAV helpers
// ---------------------------------------------------------------------------

/**
 * Wrap raw μ-law PCM data in a minimal WAV container (44-byte RIFF header).
 *
 * Twilio sends 8 kHz, mono, 8-bit μ-law audio. The WAV format code for
 * μ-law is 0x0007.
 *
 * This ensures downstream transcribers that inspect the MIME type or file
 * extension (e.g. Whisper) receive a recognised container format.
 */
function wrapMulawWav(pcm: Buffer): Buffer {
  const SAMPLE_RATE = 8000;
  const NUM_CHANNELS = 1;
  const BITS_PER_SAMPLE = 8;
  const MULAW_FORMAT_TAG = 0x0007;
  const HEADER_SIZE = 44;

  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = pcm.length;
  const fileSize = HEADER_SIZE + dataSize - 8; // RIFF chunk size excludes first 8 bytes

  const header = Buffer.alloc(HEADER_SIZE);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset);
  offset += 4;
  header.writeUInt32LE(fileSize, offset);
  offset += 4;
  header.write("WAVE", offset);
  offset += 4;

  // fmt sub-chunk
  header.write("fmt ", offset);
  offset += 4;
  header.writeUInt32LE(16, offset); // sub-chunk size (PCM = 16)
  offset += 4;
  header.writeUInt16LE(MULAW_FORMAT_TAG, offset); // audio format: μ-law
  offset += 2;
  header.writeUInt16LE(NUM_CHANNELS, offset);
  offset += 2;
  header.writeUInt32LE(SAMPLE_RATE, offset);
  offset += 4;
  header.writeUInt32LE(byteRate, offset);
  offset += 4;
  header.writeUInt16LE(blockAlign, offset);
  offset += 2;
  header.writeUInt16LE(BITS_PER_SAMPLE, offset);
  offset += 2;

  // data sub-chunk
  header.write("data", offset);
  offset += 4;
  header.writeUInt32LE(dataSize, offset);

  return Buffer.concat([header, pcm]);
}
