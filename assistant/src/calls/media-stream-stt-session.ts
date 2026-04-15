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
  /** Called when the turn detector transitions to active (first speech-bearing chunk). */
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

  /** Session-level abort controller for the active transcription request. */
  private activeTranscriptionAbort: AbortController | null = null;

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
   * Dispose of the session, clearing all timers and buffers.
   */
  dispose(): void {
    this.disposed = true;
    this.activeTranscriptionAbort?.abort();
    this.activeTranscriptionAbort = null;
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

    // Compute speech activity from the audio payload using a lightweight
    // energy heuristic. mu-law encoded audio has a companded dynamic
    // range — silence sits near 0xFF/0x7F while speech has higher energy.
    //
    // The detector call runs BEFORE the push so that the onTurnStart
    // callback can clear stale inter-turn silence from the buffer
    // without also wiping the first speech chunk of the new turn.
    const hasSpeech = detectSpeechActivity(event.media.payload);
    this.turnDetector.onMediaChunk(hasSpeech);

    this.currentTurnChunks.push(event.media.payload);
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
// Speech activity detection
// ---------------------------------------------------------------------------

/**
 * Lightweight energy-based speech activity detector for mu-law encoded audio.
 *
 * mu-law encoding compands the dynamic range so that silence values cluster
 * around 0xFF (negative zero) and 0x7F (positive zero). Speech produces
 * samples with lower byte values (higher decoded amplitude).
 *
 * This function decodes the base64 payload, computes the average absolute
 * linear amplitude of the mu-law samples, and compares it against a
 * threshold. The threshold is tuned for Twilio's 8 kHz, 8-bit mu-law
 * stream where typical silence RMS is ~50-100 and speech is >300.
 *
 * Exported for testing.
 *
 * @param base64Payload - Base64-encoded mu-law audio chunk from Twilio.
 * @returns `true` if the chunk likely contains speech, `false` otherwise.
 */
export function detectSpeechActivity(base64Payload: string): boolean {
  const SPEECH_ENERGY_THRESHOLD = 200;

  let raw: Buffer;
  try {
    raw = Buffer.from(base64Payload, "base64");
  } catch {
    return false;
  }

  if (raw.length === 0) return false;

  // Compute average absolute linear amplitude from mu-law samples.
  let totalAmplitude = 0;
  for (let i = 0; i < raw.length; i++) {
    totalAmplitude += mulawToLinearMagnitude(raw[i]);
  }
  const avgAmplitude = totalAmplitude / raw.length;

  return avgAmplitude > SPEECH_ENERGY_THRESHOLD;
}

/**
 * Convert a single mu-law byte to its approximate absolute linear magnitude.
 *
 * mu-law decoding formula (ITU-T G.711):
 * - Bit 7 is the sign bit (0 = positive, 1 = negative).
 * - Bits 6-4 are the exponent (3 bits).
 * - Bits 3-0 are the mantissa (4 bits).
 *
 * The decoded value is: sign * ((mantissa << 1 | 0x21) << exponent) - 0x21
 * We return the absolute value since we only care about energy.
 */
function mulawToLinearMagnitude(mulawByte: number): number {
  // mu-law bytes are bitwise-inverted in Twilio's encoding
  const b = ~mulawByte & 0xff;
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  const magnitude = ((mantissa << 1) | 0x21) << exponent;
  return magnitude - 0x21;
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
