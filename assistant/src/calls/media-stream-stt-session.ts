/**
 * STT session module for media-stream call ingestion.
 *
 * Consumes segmented audio turns (produced by {@link MediaTurnDetector})
 * and invokes the PR-1 telephony STT capability resolver to transcribe
 * them via the configured `services.stt` provider.
 *
 * This module is **integration-neutral** — it exposes callback hooks
 * (`onSpeechStart`, `onTranscriptFinal`, `onDtmf`, `onStop`) and is
 * not wired to any active call ingress path. A future media-stream
 * call adapter PR will instantiate and connect it.
 *
 * Error handling:
 * - When the telephony resolver returns a non-supported status, the
 *   session reports the failure through `onError` and stops processing.
 * - Individual turn transcription failures (timeouts, provider errors)
 *   are reported through `onError` without tearing down the session.
 */

import {
  resolveTelephonySttCapability,
  type TelephonySttCapability,
} from "../providers/speech-to-text/resolve.js";
import { resolveBatchTranscriber } from "../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../stt/daemon-batch-transcriber.js";
import type { SttCallContextHints } from "../stt/types.js";
import { getLogger } from "../util/logger.js";
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
}

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Callback hooks
// ---------------------------------------------------------------------------

export interface MediaStreamSttSessionCallbacks {
  /** Called when the turn detector transitions to active (first audio chunk). */
  onSpeechStart?: () => void;

  /**
   * Called when a completed turn has been transcribed successfully.
   *
   * @param text - The transcribed text (trimmed). May be empty for silence.
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

  constructor(
    config: MediaStreamSttSessionConfig = {},
    callbacks: MediaStreamSttSessionCallbacks = {},
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.transcriptionTimeoutMs =
      config.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;

    this.turnDetector = new MediaTurnDetector(config.turnDetector, {
      onTurnStart: () => {
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
   * Dispose of the session, clearing all timers and buffers.
   */
  dispose(): void {
    this.disposed = true;
    this.turnDetector.dispose();
    this.currentTurnChunks = [];
  }

  // ── Event handlers ─────────────────────────────────────────────────

  private handleStart(event: MediaStreamStartEvent): void {
    this.streamSid = event.streamSid;
    this.callSid = event.start.callSid;
    this.encoding = event.start.mediaFormat.encoding;

    log.info(
      {
        streamSid: this.streamSid,
        callSid: this.callSid,
        encoding: this.encoding,
        sampleRate: event.start.mediaFormat.sampleRate,
      },
      "Media stream STT session started",
    );

    // Eagerly resolve capability so it's cached by the time the first
    // turn completes.
    this.capabilityPromise = resolveTelephonySttCapability();
  }

  private handleMedia(event: MediaStreamMediaEvent): void {
    // Only process inbound (caller) audio
    if (event.media.track !== "inbound") return;

    this.currentTurnChunks.push(event.media.payload);
    this.turnDetector.onMediaChunk();
  }

  private handleStop(): void {
    // Finalize any in-flight turn
    this.turnDetector.forceEnd();
    this.callbacks.onStop?.();
  }

  // ── Turn completion ────────────────────────────────────────────────

  private async handleTurnEnd(
    _reason: "silence" | "max-duration",
    durationMs: number,
  ): Promise<void> {
    const chunks = this.currentTurnChunks;
    this.currentTurnChunks = [];

    if (chunks.length === 0) {
      // Silence turn — no audio to transcribe.
      this.callbacks.onTranscriptFinal?.("", durationMs);
      return;
    }

    // Resolve telephony capability (cached after first call)
    if (!this.capabilityPromise) {
      this.capabilityPromise = resolveTelephonySttCapability();
    }
    const capability = await this.capabilityPromise;

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
    const audioBuffer = this.decodeAudioChunks(chunks);

    // Resolve a batch transcriber for the configured provider.
    let transcriber;
    try {
      transcriber = await resolveBatchTranscriber();
    } catch (err) {
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
      return;
    }

    if (!transcriber) {
      this.callbacks.onError?.(
        "unconfigured",
        "No batch transcriber available for the configured STT provider",
      );
      return;
    }

    // Transcribe with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.transcriptionTimeoutMs,
    );

    try {
      const result = await transcriber.transcribe({
        audio: audioBuffer,
        mimeType:
          this.encoding === "audio/x-mulaw" ? "audio/mulaw" : "audio/raw",
        signal: controller.signal,
        callContext: this.config.callContextHints,
      });

      this.callbacks.onTranscriptFinal?.(result.text, durationMs);
    } catch (err) {
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
    } finally {
      clearTimeout(timeoutId);
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
