/**
 * Google Gemini incremental-batch streaming STT adapter.
 *
 * Google Gemini does not expose a native WebSocket streaming transcription
 * endpoint. This adapter approximates streaming by accumulating audio chunks
 * and periodically submitting the accumulated buffer to the Gemini
 * `models.generateContent` endpoint, then diffing the response against the
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
 *
 * Implements the {@link StreamingTranscriber} contract from `stt/types.ts`
 * so the runtime session orchestrator (PR 5) can use it interchangeably
 * with the Deepgram realtime-ws adapter.
 */

import { GoogleGenAI } from "@google/genai";

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { encodePcm16LeToWav } from "../../stt/wav-encoder.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("google-gemini-stream");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Minimum interval between incremental batch requests (ms).
 * Prevents excessive API calls while the user is actively speaking.
 */
export const POLL_INTERVAL_MS = 1_000;

/**
 * Timeout per individual batch request (ms).
 * Prevents a single slow request from blocking the streaming pipeline.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_FIRST_PCM_PARTIAL_AUDIO_MS = 1_500;
const META_RESPONSE_PATTERNS: RegExp[] = [
  /\b(did not provide|no)\s+an?\s+audio\s+file\b/i,
  /\bno\s+audio\s+(was\s+)?provided\b/i,
  /\bunable\s+to\s+transcrib(e|ing)\b/i,
  /\bcannot\s+transcrib(e|ing)\b/i,
  /\bplease\s+provide\s+audio\b/i,
];

const TRANSCRIPTION_PROMPT =
  "Transcribe only words actually present in the audio. Return only the transcript text. If the audio is silent, unclear, or too incomplete to transcribe confidently, return an empty string. Do not guess and do not add commentary.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoogleGeminiStreamOptions {
  /** Gemini model to use (default: "gemini-2.5-flash"). */
  model?: string;
  /** Override the Google AI API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
  /** Override the poll interval for testing (default: POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Sample rate for raw PCM input; used when wrapping PCM in WAV. */
  pcmSampleRate?: number;
  /** Channel count for raw PCM input; used when wrapping PCM in WAV. */
  pcmChannels?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GoogleGeminiStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "google-gemini" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly client: GoogleGenAI;
  private readonly model: string;
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
  /** First interim candidate for PCM sessions; emitted only after stabilization. */
  private pendingFirstPcmPartial = "";

  /** Event callback registered via start(). */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(apiKey: string, options: GoogleGeminiStreamOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pcmSampleRate = options.pcmSampleRate ?? 48_000;
    this.pcmChannels = options.pcmChannels ?? 1;

    this.client = options.baseUrl
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { baseUrl: options.baseUrl },
        })
      : new GoogleGenAI({ apiKey });
  }

  // -----------------------------------------------------------------------
  // StreamingTranscriber interface
  // -----------------------------------------------------------------------

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.started) {
      throw new Error("GoogleGeminiStreamingTranscriber: already started");
    }
    this.onEvent = onEvent;
    this.started = true;
    // Avoid firing the first poll immediately on the first audio chunk.
    // We want at least one poll interval of buffered audio context.
    this.lastPollTime = Date.now();

    log.info(
      { model: this.model, pollIntervalMs: this.pollIntervalMs },
      "Google Gemini streaming session started",
    );
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    if (!this.started) {
      throw new Error(
        "GoogleGeminiStreamingTranscriber: sendAudio called before start()",
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

    log.info("Stopping Google Gemini streaming session");

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Fire the final batch asynchronously; the session stays open until
    // the final event and closed event are emitted.
    void this.emitFinal();
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
      void this.doPoll();
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
      const text = await this.transcribeAccumulated();

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

      const nextText = text.trim();
      if (!nextText) return;
      if (this.isLikelyMetaResponse(nextText)) return;

      // PCM streams from chat dictation are especially prone to low-context
      // hallucinated early partials. Gate the first emitted partial until:
      // 1) enough audio is buffered, and 2) two consecutive polls agree on a
      // stable prefix.
      if (this.isPcmMimeType(this.audioMimeType) && !this.lastEmittedText) {
        const durationMs = this.getAccumulatedPcmDurationMs();
        if (durationMs < MIN_FIRST_PCM_PARTIAL_AUDIO_MS) {
          return;
        }

        if (!this.pendingFirstPcmPartial) {
          this.pendingFirstPcmPartial = nextText;
          return;
        }

        if (
          !this.hasStrongPrefixOverlap(nextText, this.pendingFirstPcmPartial)
        ) {
          this.pendingFirstPcmPartial = nextText;
          return;
        }

        const candidate =
          nextText.length >= this.pendingFirstPcmPartial.length
            ? nextText
            : this.pendingFirstPcmPartial;
        this.pendingFirstPcmPartial = "";
        this.lastEmittedText = candidate;
        this.emit({ type: "partial", text: candidate });
        return;
      }

      // Only emit a partial if the text has changed and appears to move
      // forward from the last emitted partial.
      if (
        nextText !== this.lastEmittedText &&
        this.isForwardProgression(nextText, this.lastEmittedText)
      ) {
        this.lastEmittedText = nextText;
        this.emit({ type: "partial", text: nextText });
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
        const text = await this.transcribeAccumulated();
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
      log.info("Google Gemini streaming session closed");
      this.emit({ type: "closed" });
    }
  }

  // -----------------------------------------------------------------------
  // Batch transcription helper
  // -----------------------------------------------------------------------

  /**
   * Concatenate all accumulated audio chunks and send a single batch
   * request to the Gemini API.
   */
  private async transcribeAccumulated(): Promise<string> {
    const rawAudio = Buffer.concat(this.audioChunks);
    const rawMimeType = this.audioMimeType;
    const isPcm = this.isPcmMimeType(rawMimeType);
    const audio = isPcm
      ? encodePcm16LeToWav(rawAudio, {
          sampleRate: this.pcmSampleRate,
          channels: this.pcmChannels,
        })
      : rawAudio;
    const mimeType = isPcm ? "audio/wav" : rawMimeType;
    const base64Audio = audio.toString("base64");

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
            { text: TRANSCRIPTION_PROMPT },
          ],
        },
      ],
      config: {
        temperature: 0,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });

    return response.text?.trim() ?? "";
  }

  private isPcmMimeType(mimeType: string): boolean {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    return base === "audio/pcm";
  }

  private getAccumulatedPcmDurationMs(): number {
    if (!this.isPcmMimeType(this.audioMimeType)) return 0;
    const bytesPerSecond = this.pcmSampleRate * this.pcmChannels * 2;
    if (bytesPerSecond <= 0) return 0;
    const bytes = this.audioChunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
    return (bytes / bytesPerSecond) * 1_000;
  }

  private hasStrongPrefixOverlap(a: string, b: string): boolean {
    const minLen = Math.min(a.length, b.length);
    if (minLen === 0) return false;
    const shared = this.commonPrefixLength(a, b);
    return shared >= Math.min(minLen, 16);
  }

  private commonPrefixLength(a: string, b: string): number {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a[i] === b[i]) i++;
    return i;
  }

  private isForwardProgression(next: string, prev: string): boolean {
    if (!prev) return true;
    if (next.length < prev.length) return false;
    return next.startsWith(prev);
  }

  private isLikelyMetaResponse(text: string): boolean {
    return META_RESPONSE_PATTERNS.some((pattern) => pattern.test(text));
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
        "Listener error in Google Gemini streaming adapter",
      );
    }
  }
}
