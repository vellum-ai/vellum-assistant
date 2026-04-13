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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gemini-2.0-flash";

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

const TRANSCRIPTION_PROMPT =
  "Transcribe the audio exactly as spoken. Return only the transcribed text with no additional commentary, labels, or formatting.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoogleGeminiStreamOptions {
  /** Gemini model to use (default: "gemini-2.0-flash"). */
  model?: string;
  /** Override the Google AI API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
  /** Override the poll interval for testing (default: POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
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

  /** Event callback registered via start(). */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(apiKey: string, options: GoogleGeminiStreamOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

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

    try {
      const text = await this.transcribeAccumulated();

      // Guard: if stop() was called while we were awaiting the API
      // response, emitFinal() may have already sent final/closed.
      // Emitting a partial after closed violates the streaming contract.
      if (this.stopped) return;

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
    try {
      if (this.audioChunks.length > 0) {
        const text = await this.transcribeAccumulated();
        this.emit({ type: "final", text: text || this.lastEmittedText });
      } else {
        // No audio was ever sent — emit empty final.
        this.emit({ type: "final", text: this.lastEmittedText });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", category: "provider-error", message });
      // Still emit a best-effort final from the last known partial.
      this.emit({ type: "final", text: this.lastEmittedText });
    } finally {
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
    const combined = Buffer.concat(this.audioChunks);
    const base64Audio = combined.toString("base64");

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: this.audioMimeType,
                data: base64Audio,
              },
            },
            { text: TRANSCRIPTION_PROMPT },
          ],
        },
      ],
      config: {
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });

    return response.text?.trim() ?? "";
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}
