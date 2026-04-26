/**
 * OpenAI Whisper incremental-batch streaming STT adapter.
 *
 * OpenAI Whisper does not expose a native WebSocket streaming transcription
 * endpoint. This adapter approximates streaming by accumulating audio chunks
 * and periodically submitting the accumulated buffer to the Whisper
 * `/v1/audio/transcriptions` endpoint, then diffing the response against the
 * previous transcript to emit stable partial updates.
 *
 * Key design decisions:
 * - **Throttled polling**: A minimum interval (`POLL_INTERVAL_MS`) between
 *   batch requests prevents excessive API calls while the user is speaking.
 * - **Overlap/diff logic**: Each batch includes the full accumulated audio,
 *   so the model sees complete context. The adapter compares each new
 *   transcript against the last emitted partial to avoid sending duplicate
 *   or regressive (flickering) text to the UI.
 * - **Deterministic final**: On `stop()` the adapter sends one final batch
 *   request with the complete audio and emits a `final` event followed by
 *   `closed`, regardless of what partials were sent earlier.
 * - **PCM-to-WAV transcoding**: When the incoming audio MIME type is
 *   `audio/pcm`, accumulated PCM chunks are wrapped in a WAV container
 *   via `encodePcm16LeToWav` before each Whisper request, since the
 *   `/v1/audio/transcriptions` endpoint requires a supported container
 *   format.
 *
 * Implements the {@link StreamingTranscriber} contract from `stt/types.ts`
 * so the runtime session orchestrator can use it interchangeably with the
 * Deepgram realtime-ws and Google Gemini Live API adapters.
 */

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { encodePcm16LeToWav } from "../../stt/wav-encoder.js";
import { getLogger } from "../../util/logger.js";
import { whisperTranscribe } from "./openai-whisper.js";

const log = getLogger("openai-whisper-stream");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum interval between incremental batch requests (ms).
 * Prevents excessive API calls while the user is actively speaking.
 *
 * Tuned lower than 1s so chat-composer dictation feels more responsive:
 * OpenAI Whisper remains incremental-batch (not true token streaming), but
 * a tighter poll cadence reduces perceived latency for partial updates.
 */
const POLL_INTERVAL_MS = 400;

/**
 * Timeout per incremental poll request (ms).
 * Keeps the streaming pipeline responsive during active dictation.
 */
const POLL_TIMEOUT_MS = 15_000;

/**
 * Timeout for the final flush request (ms).
 * The final request transcribes the full accumulated recording, which can
 * be significantly larger than an incremental poll batch — allow more time
 * so legitimate long recordings are not truncated.
 */
const FINAL_TIMEOUT_MS = 30_000;

/**
 * Default PCM sample rate when the streaming session does not explicitly
 * provide format metadata. 16 kHz mono is the most common capture rate
 * for browser-based microphone input sent as raw PCM.
 */
const DEFAULT_PCM_SAMPLE_RATE = 16_000;

/**
 * Default PCM channel count for WAV wrapping.
 */
const DEFAULT_PCM_CHANNELS = 1;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIWhisperStreamOptions {
  /** Override the poll interval for testing (default: POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** PCM sample rate in Hz when receiving `audio/pcm` input (default: 16000). */
  pcmSampleRate?: number;
  /** PCM channel count when receiving `audio/pcm` input (default: 1). */
  pcmChannels?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIWhisperStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "openai-whisper" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly pcmSampleRate: number;
  private readonly pcmChannels: number;

  /** Accumulated audio chunks across the entire session. */
  private audioChunks: Buffer[] = [];
  /** MIME type of the accumulated audio (set on first audio chunk). */
  private audioMimeType = "audio/webm";

  /** The last partial transcript emitted to the client. */
  private lastEmittedText = "";
  /** Whether `start()` has been called and the session is active. */
  private started = false;
  /** Whether `stop()` has been called. */
  private stopped = false;

  /** Timer handle for the throttled polling loop. */
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last batch request completion. */
  private lastPollTime = 0;
  /** Whether a batch request is currently in flight. */
  private polling = false;
  /** Whether new audio has arrived since the last poll. */
  private audioDirty = false;

  /** Promise tracking the currently in-flight poll (if any). */
  private inflightPoll: Promise<void> | null = null;

  /** Event callback registered via start(). */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(apiKey: string, options: OpenAIWhisperStreamOptions = {}) {
    this.apiKey = apiKey;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pcmSampleRate = options.pcmSampleRate ?? DEFAULT_PCM_SAMPLE_RATE;
    this.pcmChannels = options.pcmChannels ?? DEFAULT_PCM_CHANNELS;
  }

  // -----------------------------------------------------------------------
  // StreamingTranscriber interface
  // -----------------------------------------------------------------------

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.started) {
      throw new Error("OpenAIWhisperStreamingTranscriber: already started");
    }
    this.onEvent = onEvent;
    this.started = true;

    log.info(
      { pollIntervalMs: this.pollIntervalMs },
      "OpenAI Whisper streaming session started",
    );
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    if (!this.started) {
      throw new Error(
        "OpenAIWhisperStreamingTranscriber: sendAudio called before start()",
      );
    }
    if (this.stopped) return;

    this.audioChunks.push(audio);
    this.audioMimeType = mimeType;
    this.audioDirty = true;

    this.schedulePoll();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    log.info("Stopping OpenAI Whisper streaming session");

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for any in-flight poll to settle before sending the final
    // request. This prevents a race where the final emits stale
    // `lastEmittedText` while a concurrent poll is still in progress
    // with newer data.
    const pending = this.inflightPoll ?? Promise.resolve();
    void pending.then(() => this.emitFinal());
  }

  // -----------------------------------------------------------------------
  // Internal polling
  // -----------------------------------------------------------------------

  /**
   * Schedule the next poll if one is not already pending.
   *
   * Respects the minimum poll interval to avoid flooding the API.
   */
  private schedulePoll(): void {
    if (this.pollTimer || this.stopped) return;

    const elapsed = Date.now() - this.lastPollTime;
    const delay = Math.max(0, this.pollIntervalMs - elapsed);

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      const p = this.doPoll();
      this.inflightPoll = p;
      void p.finally(() => {
        if (this.inflightPoll === p) this.inflightPoll = null;
      });
    }, delay);
  }

  /**
   * Execute a single incremental batch request and emit a partial event
   * if the transcript has advanced.
   */
  private async doPoll(): Promise<void> {
    if (this.stopped || this.polling || !this.audioDirty) return;

    this.polling = true;
    this.audioDirty = false;

    log.debug(
      { chunks: this.audioChunks.length },
      "Executing incremental poll",
    );

    try {
      const text = await this.transcribeAccumulated(POLL_TIMEOUT_MS);

      // Guard: if stop() was called while we were awaiting the API
      // response, emitFinal() may have already sent final/closed.
      // Emitting a partial after closed violates the streaming contract.
      // However, preserve the transcribed text so the fallback final in
      // emitFinal() uses the most up-to-date transcript if the final
      // batch request fails.
      if (this.stopped) {
        if (text && text.length >= this.lastEmittedText.length) {
          this.lastEmittedText = text;
        }
        return;
      }

      // Only emit a partial if the text has actually changed AND is
      // a forward progression (longer or substantially different).
      // This prevents flickering when the model returns a shorter
      // intermediate result.
      if (
        text &&
        text !== this.lastEmittedText &&
        text.length >= this.lastEmittedText.length
      ) {
        this.lastEmittedText = text;
        this.emit({ type: "partial", text });
      }
    } catch (err) {
      // Transient errors during polling are non-fatal — the final
      // request on stop() will capture the complete audio.
      log.warn({ error: err }, "Incremental poll request failed");
      if (!this.stopped) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", category: "provider-error", message });
      }
    } finally {
      // Record poll completion time in both success and error paths so
      // that throttling still applies when requests fail quickly —
      // otherwise stale lastPollTime causes immediate retries on each
      // sendAudio() call, producing request bursts.
      this.lastPollTime = Date.now();
      this.polling = false;
    }

    // If more audio arrived while we were polling, schedule again.
    if (this.audioDirty && !this.stopped) {
      this.schedulePoll();
    }
  }

  // -----------------------------------------------------------------------
  // Final transcript
  // -----------------------------------------------------------------------

  /**
   * Send the complete accumulated audio for a deterministic final
   * transcript, then close the session.
   */
  private async emitFinal(): Promise<void> {
    log.info(
      { chunks: this.audioChunks.length },
      "Sending final transcription request",
    );

    try {
      if (this.audioChunks.length > 0) {
        const text = await this.transcribeAccumulated(FINAL_TIMEOUT_MS);
        log.info("Final transcription request complete");
        this.emit({ type: "final", text: text || this.lastEmittedText });
      } else {
        // No audio was ever sent — emit empty final.
        this.emit({ type: "final", text: this.lastEmittedText });
      }
    } catch (err) {
      log.error({ error: err }, "Final transcription request failed");
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", category: "provider-error", message });
      // Still emit a best-effort final from the last known partial.
      this.emit({ type: "final", text: this.lastEmittedText });
    } finally {
      log.info("OpenAI Whisper streaming session closed");
      this.emit({ type: "closed" });
    }
  }

  // -----------------------------------------------------------------------
  // Batch transcription helper
  // -----------------------------------------------------------------------

  /**
   * Concatenate all accumulated audio chunks and send a single batch
   * request to the Whisper API.
   *
   * When the MIME type is `audio/pcm`, the raw PCM data is wrapped in a
   * WAV container before submission since Whisper requires a supported
   * container format.
   */
  private async transcribeAccumulated(timeoutMs: number): Promise<string> {
    const rawAudio = Buffer.concat(this.audioChunks);
    const rawMimeType = this.audioMimeType;

    // PCM streaming input must be WAV-wrapped for Whisper compatibility.
    const isPcm = this.isPcmMimeType(rawMimeType);
    const audio = isPcm
      ? encodePcm16LeToWav(rawAudio, {
          sampleRate: this.pcmSampleRate,
          channels: this.pcmChannels,
        })
      : rawAudio;
    const mimeType = isPcm ? "audio/wav" : rawMimeType;

    return whisperTranscribe(
      this.apiKey,
      audio,
      mimeType,
      AbortSignal.timeout(timeoutMs),
    );
  }

  /**
   * Check whether a MIME type represents raw PCM16LE audio that needs
   * container wrapping before Whisper can accept it.
   *
   * Only `audio/pcm` (little-endian by convention in this codebase) is
   * accepted. `audio/l16` is intentionally excluded because it is
   * big-endian per RFC 3551 and would require byte-swapping before
   * WAV encoding.
   */
  private isPcmMimeType(mimeType: string): boolean {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    return base === "audio/pcm";
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private emit(event: SttStreamServerEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      log.warn(
        { error: err },
        "Listener error in OpenAI Whisper streaming adapter",
      );
    }
  }
}
