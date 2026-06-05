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

import { getConfig } from "../config/loader.js";
import {
  isRealtimeStreamingProvider,
  resolveStreamingTranscriber,
  resolveTelephonySttCapability,
  type TelephonySttCapability,
} from "../providers/speech-to-text/resolve.js";
import { resolveBatchTranscriber } from "../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../stt/daemon-batch-transcriber.js";
import type {
  StreamingTranscriber,
  SttCallContextHints,
  SttStreamServerEvent,
  SttStreamServerFinalEvent,
} from "../stt/types.js";
import { getLogger } from "../util/logger.js";
import { mulawToPcm16, resamplePcm16 } from "./media-stream-audio-transcode.js";
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
   * Force streaming on/off, bypassing the `calls.voice.telephonyStreaming`
   * config flag. Primarily for tests. When omitted, the config flag decides.
   */
  forceStreaming?: boolean;
}

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10_000;

/**
 * Approximate wall-clock duration of a single Twilio media frame, in
 * milliseconds. Twilio sends 8 kHz mu-law in ~20 ms (160-sample) frames. Used
 * to convert the turn-detector silence threshold (ms) into a frame count for
 * the streaming speech-start gate.
 */
const TELEPHONY_FRAME_MS = 20;

/**
 * Default silence threshold (ms) used to reset the streaming speech-start gate
 * when no explicit turn-detector silence threshold is configured. Mirrors the
 * batch {@link MediaTurnDetector} default so streaming barge-in turns are
 * debounced on the same cadence as batch turns.
 */
const DEFAULT_STREAMING_SILENCE_THRESHOLD_MS = 800;

/**
 * Sample rate (Hz) of Twilio telephony media-stream audio.
 */
const TELEPHONY_SAMPLE_RATE = 8_000;

/**
 * Sample rate (Hz) we upsample telephony audio to before feeding the
 * streaming transcriber. Streaming adapters default to 16 kHz, so we
 * resample once and configure the transcriber for the same rate.
 */
const STREAMING_SAMPLE_RATE = 16_000;

/** MIME type for the raw PCM16 frames sent to the streaming transcriber. */
const STREAMING_PCM_MIME = "audio/pcm";

/**
 * Maximum number of inbound PCM frames buffered while the streaming
 * transcriber is starting up. Each frame is ~20 ms of audio, so this caps
 * the startup buffer at roughly 10 seconds — far longer than any real
 * provider handshake. Frames beyond the cap drop oldest-first and increment
 * a diagnostic counter logged on teardown.
 */
const MAX_STREAMING_STARTUP_FRAMES = 500;

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

  // ── Streaming-mode state ───────────────────────────────────────────

  /**
   * Mode decided synchronously at {@link handleStart}, before any resolver is
   * awaited:
   * - `"batch"` — streaming flag is off; use the batch turn detector.
   * - `"streaming-pending"` — streaming flag is on and the transcriber
   *   resolver is still in flight. ALL inbound media frames are buffered into
   *   {@link streamingStartupBuffer} during this window; none reach the batch
   *   turn detector, so an utterance is never split across the two paths.
   * - `"streaming"` — a live transcriber resolved and started.
   *
   * Once the resolver settles, `"streaming-pending"` transitions to either
   * `"streaming"` (live transcriber → flush buffer into it) or `"batch"`
   * (resolver returned null/threw → feed buffered frames into the batch path).
   */
  private mode: "batch" | "streaming-pending" | "streaming" = "batch";

  /**
   * Active streaming transcriber, set once the resolver yields a live
   * transcriber. `null` while pending or when the batch fallback is in use.
   */
  private streamingTranscriber: StreamingTranscriber | null = null;

  /** Whether the streaming transcriber's `start()` promise has resolved. */
  private streamingReady = false;

  /**
   * Accumulated committed (`final`) transcript segments for the in-progress
   * caller utterance, awaiting the provider's utterance boundary.
   *
   * Some providers (Deepgram) commit multiple per-segment finals within a
   * single spoken sentence (`is_final`) and only mark the natural pause
   * separately (`speech_final` / `UtteranceEnd`, surfaced as
   * `endOfUtterance: true`). Routing every committed segment to
   * `onTranscriptFinal` would trigger an assistant reply mid-sentence, so we
   * buffer segments here and flush a single concatenated `onTranscriptFinal`
   * at the boundary. Providers without a separate boundary signal emit
   * `endOfUtterance: undefined`, which flushes immediately — preserving the
   * one-final-per-utterance behavior.
   */
  private streamingUtteranceSegments: string[] = [];

  /**
   * Set when a Twilio `stop` arrives (or {@link dispose} is called) while the
   * session is still in `"streaming-pending"` — i.e. before the streaming
   * resolver/`start()` has settled. Once set, the in-flight
   * {@link startStreamingMode} must NOT commit to streaming: a late-resolved
   * transcriber is stopped and discarded so it doesn't resurrect the streaming
   * path after the call has already ended (and its buffered frames flushed to
   * batch).
   */
  private streamingAborted = false;

  /**
   * Inbound raw base64 mu-law payloads buffered during the
   * `"streaming-pending"` window. Held as raw payloads (not decoded PCM) so
   * they can be flushed into EITHER path once the mode resolves: decoded and
   * sent to the streaming transcriber, or fed through the batch turn detector.
   * Flushed (and cleared) once the resolver settles.
   */
  private streamingStartupBuffer: string[] = [];

  /**
   * Count of frames dropped from the bounded startup buffer because it
   * exceeded {@link MAX_STREAMING_STARTUP_FRAMES}. Logged on teardown.
   */
  private streamingStartupFramesDropped = 0;

  // ── Streaming speech-start gate ────────────────────────────────────
  //
  // In streaming mode the local VAD classifies EVERY 20 ms media frame, so a
  // single utterance produces a long run of speech-bearing frames. Firing
  // onSpeechStart for each one repeatedly clears outbound audio and inflates
  // turn diagnostics. We gate it to once per speech turn (the silence→speech
  // rising edge), then arm it again only after an intervening silence gap —
  // mirroring how the batch MediaTurnDetector debounces turn starts.

  /** Whether a streaming speech turn is currently in progress. */
  private streamingSpeechActive = false;

  /** Consecutive silence (non-speech) frames seen since the last speech frame. */
  private streamingSilenceFrames = 0;

  /**
   * Number of consecutive silence frames that resets the speech-start gate.
   * Derived from the configured turn-detector silence threshold so streaming
   * barge-in is debounced on the same cadence as batch turn segmentation.
   */
  private readonly streamingSilenceResetFrames: number;

  constructor(
    config: MediaStreamSttSessionConfig = {},
    callbacks: MediaStreamSttSessionCallbacks = {},
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.transcriptionTimeoutMs =
      config.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;

    // Convert the configured silence threshold (ms) into a frame count so the
    // streaming speech-start gate resets after the same amount of silence that
    // ends a batch turn. At least one frame so a single silent frame can never
    // be required to be fractional.
    const silenceThresholdMs =
      config.turnDetector?.silenceThresholdMs ??
      DEFAULT_STREAMING_SILENCE_THRESHOLD_MS;
    this.streamingSilenceResetFrames = Math.max(
      1,
      Math.round(silenceThresholdMs / TELEPHONY_FRAME_MS),
    );

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
    // If a streaming startup is still in flight, mark it aborted so the
    // pending resolver tears down (and does not leak) any late-resolved
    // transcriber rather than committing to streaming on a dead session.
    this.streamingAborted = true;
    this.activeTranscriptionAbort?.abort();
    this.activeTranscriptionAbort = null;
    this.turnDetector.dispose();
    this.currentTurnChunks = [];

    if (this.streamingStartupFramesDropped > 0) {
      log.warn(
        {
          streamSid: this.streamSid,
          dropped: this.streamingStartupFramesDropped,
        },
        "Dropped media frames from streaming startup buffer (over cap)",
      );
    }

    // Only tear the transcriber down here when streaming has fully committed
    // (`mode === "streaming"`). While `"streaming-pending"`, the in-flight
    // startStreamingMode owns the (local) transcriber: streamingAborted is set
    // above, so when its `start()` settles it stops and discards the late
    // transcriber itself — stopping it here too would double-stop it.
    if (this.mode === "streaming" && this.streamingTranscriber) {
      this.streamingTranscriber.stop();
      this.streamingTranscriber = null;
    }
    this.streamingReady = false;
    this.streamingStartupBuffer = [];
    this.streamingUtteranceSegments = [];
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

    // Select streaming vs batch ONCE at start; do not mix paths thereafter.
    // The decision is recorded SYNCHRONOUSLY here so that media frames arriving
    // before the (async) streaming resolver settles are buffered into the
    // startup buffer rather than leaking into the batch turn detector.
    if (this.streamingEnabled()) {
      this.mode = "streaming-pending";
      void this.startStreamingMode();
      return;
    }

    // Batch fallback path: eagerly resolve capability so it's cached by the
    // time the first turn completes.
    this.mode = "batch";
    this.capabilityPromise = resolveTelephonySttCapability();
  }

  /**
   * Whether the realtime streaming STT path should be attempted for this
   * session.
   *
   * Two conditions must hold:
   * 1. The `calls.voice.telephonyStreaming` config flag is on (or
   *    `forceStreaming` overrides it — primarily for tests).
   * 2. The configured STT provider's streaming is *genuinely realtime*
   *    (`conversationStreamingMode === "realtime-ws"`). Providers like OpenAI
   *    Whisper are `incremental-batch`: their streaming transcriber only emits
   *    a `final` on `stop()`, so the realtime path would never produce a
   *    mid-call transcript. Those must use the batch turn-segmenting path.
   *
   * When `forceStreaming` is set it bypasses BOTH the config flag and the
   * provider realtime check, so tests can exercise the streaming path with a
   * fake transcriber regardless of the configured provider.
   */
  private streamingEnabled(): boolean {
    if (this.config.forceStreaming !== undefined) {
      return this.config.forceStreaming;
    }
    let flagOn = false;
    try {
      flagOn = getConfig().calls.voice.telephonyStreaming;
    } catch {
      // Config unavailable (early startup / tests) — default to batch path.
      return false;
    }
    if (!flagOn) return false;
    // Only take the realtime path for providers that stream in true realtime;
    // incremental-batch providers (e.g. Whisper) use the batch path.
    return isRealtimeStreamingProvider();
  }

  /**
   * Open a streaming transcriber for the session. Inbound frames that arrive
   * before `start()` resolves are buffered (bounded) and flushed on success.
   * Falls back to the batch path if no streaming transcriber is available.
   */
  private async startStreamingMode(): Promise<void> {
    let transcriber: StreamingTranscriber | null;
    try {
      transcriber = await resolveStreamingTranscriber({
        // We resample telephony audio up to STREAMING_SAMPLE_RATE before
        // sending, so configure the transcriber for that selected rate.
        sampleRate: STREAMING_SAMPLE_RATE,
      });
    } catch (err) {
      if (this.disposed || this.streamingAborted) return;
      // Resolver threw — definitively fall back to batch and replay the
      // frames buffered during the pending window so none are lost.
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
      this.fallBackToBatch();
      return;
    }
    if (this.disposed || this.streamingAborted) {
      // Stop/dispose landed during the pending window; the buffered frames
      // were already flushed to the batch path. Discard the late transcriber.
      transcriber?.stop();
      return;
    }

    if (!transcriber) {
      // No streaming transcriber — fall back to the batch path and replay the
      // frames buffered during the pending window.
      log.info(
        { streamSid: this.streamSid },
        "No streaming transcriber available; falling back to batch STT",
      );
      this.fallBackToBatch();
      return;
    }

    this.streamingTranscriber = transcriber;

    try {
      await transcriber.start((event) => this.handleStreamingEvent(event));
    } catch (err) {
      if (this.disposed || this.streamingAborted) {
        this.streamingTranscriber = null;
        return;
      }
      // `start()` threw — drop the transcriber and fall back to batch,
      // replaying the buffered frames into the batch path.
      this.streamingTranscriber = null;
      const normalized = normalizeSttError(err);
      this.callbacks.onError?.(normalized.category, normalized.message);
      this.fallBackToBatch();
      return;
    }
    if (this.disposed || this.streamingAborted) {
      // Stop/dispose landed during the pending window; buffered frames already
      // went to the batch path. Tear the late transcriber down.
      transcriber.stop();
      this.streamingTranscriber = null;
      return;
    }

    // Live transcriber is ready. Commit to streaming mode and flush the frames
    // buffered during the pending window (decode → resample → send) in order.
    this.mode = "streaming";
    this.streamingReady = true;
    const buffered = this.streamingStartupBuffer;
    this.streamingStartupBuffer = [];
    for (const payload of buffered) {
      const pcm = this.decodeForStreaming(payload);
      if (pcm) transcriber.sendAudio(pcm, STREAMING_PCM_MIME);
    }
  }

  /**
   * Resolver did not yield a usable streaming transcriber (flag-on but null,
   * or `start()`/resolver threw). Commit to the batch path, eagerly resolve
   * telephony capability, and replay any frames buffered during the pending
   * window through the batch pipeline so the first utterance is not lost.
   */
  private fallBackToBatch(): void {
    this.mode = "batch";
    this.streamingTranscriber = null;
    this.streamingReady = false;
    this.capabilityPromise = resolveTelephonySttCapability();

    const buffered = this.streamingStartupBuffer;
    this.streamingStartupBuffer = [];
    for (const payload of buffered) {
      this.feedBatch(payload);
    }
  }

  /**
   * Handle a server event from the streaming transcriber. `onSpeechStart`
   * is driven by local VAD (for barge-in latency), so partials are not
   * surfaced here — only finals, errors, and close.
   *
   * `final` segments are gated on the provider's utterance boundary: we
   * accumulate consecutive committed segments and only flush one
   * concatenated `onTranscriptFinal` when the segment marks the end of the
   * utterance (`endOfUtterance !== false`). Providers that do not signal a
   * separate boundary emit `endOfUtterance: undefined`, so each `final`
   * flushes immediately — see {@link handleStreamingFinal}.
   */
  private handleStreamingEvent(event: SttStreamServerEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "final":
        this.handleStreamingFinal(event);
        break;
      case "error":
        this.callbacks.onError?.(event.category, event.message);
        break;
      case "closed":
        // Session-level `onStop` is driven by the Twilio `stop` event
        // (`handleStop`); the provider `closed` event is teardown only.
        this.streamingReady = false;
        break;
      case "partial":
        // Partials are intentionally ignored — barge-in is driven by the
        // fast local VAD instead of waiting for the first partial.
        break;
    }
  }

  /**
   * Gate a streaming `final` event on the provider's utterance boundary.
   *
   * - `endOfUtterance === false` — mid-utterance committed segment. Buffer the
   *   text and wait; do NOT fire onTranscriptFinal yet (avoids a mid-sentence
   *   assistant reply).
   * - `endOfUtterance === true` or `undefined` — utterance boundary (or a
   *   provider with no separate boundary signal). Concatenate any buffered
   *   segments with this one, reset the buffer, and flush a single
   *   onTranscriptFinal.
   *
   * Empty boundary finals with no buffered text (e.g. a standalone Deepgram
   * `UtteranceEnd` after silence) are dropped so a bare boundary does not emit
   * an empty transcript.
   */
  private handleStreamingFinal(event: SttStreamServerFinalEvent): void {
    const text = event.text.trim();

    if (event.endOfUtterance === false) {
      // Mid-utterance committed segment — accumulate, do not flush.
      if (text.length > 0) this.streamingUtteranceSegments.push(text);
      return;
    }

    // Utterance boundary (true) or a provider with no boundary signal
    // (undefined): flush the accumulated segments plus this one as a single
    // transcript.
    if (text.length > 0) this.streamingUtteranceSegments.push(text);
    const combined = this.streamingUtteranceSegments.join(" ");
    this.streamingUtteranceSegments = [];

    // A bare boundary (e.g. UtteranceEnd) with nothing buffered carries no
    // transcript — drop it rather than firing an empty reply.
    if (combined.length === 0) return;

    this.callbacks.onTranscriptFinal?.(combined, 0);
  }

  private handleMedia(event: MediaStreamMediaEvent): void {
    // Only process inbound (caller) audio
    if (event.media.track !== "inbound") return;

    const payload = event.media.payload;

    switch (this.mode) {
      case "streaming-pending":
        // Streaming resolver still in flight. Drive barge-in immediately from
        // the local VAD (coalesced to once per speech turn), but buffer the raw
        // payload — it must NOT reach the batch turn detector, or the first
        // utterance would be split across both paths. The buffer is replayed
        // into whichever path wins.
        this.noteStreamingSpeechActivity(detectSpeechActivity(payload));
        this.bufferStartupFrame(payload);
        return;

      case "streaming":
        // Live streaming: decode/resample and send, driving barge-in from the
        // fast local VAD rather than waiting for the transcriber's partial.
        this.handleStreamingMedia(payload);
        return;

      case "batch":
        this.feedBatch(payload);
        return;
    }
  }

  /**
   * Route a single inbound media frame through the streaming pipeline:
   * decode mu-law → PCM16, resample to the streaming rate, fire local-VAD
   * barge-in, and send to the (ready) transcriber.
   */
  private handleStreamingMedia(base64Payload: string): void {
    // Drive barge-in from the fast local VAD (energy heuristic), coalesced to
    // once per speech turn so a normal utterance does not repeatedly clear
    // outbound audio or inflate turn diagnostics.
    this.noteStreamingSpeechActivity(detectSpeechActivity(base64Payload));

    const pcm = this.decodeForStreaming(base64Payload);
    if (!pcm) return;

    if (this.streamingReady) {
      this.streamingTranscriber?.sendAudio(pcm, STREAMING_PCM_MIME);
    }
  }

  /**
   * Coalesce streaming speech-start callbacks to once per speech turn.
   *
   * Fires `onSpeechStart` only on the silence→speech rising edge (immediately,
   * to keep barge-in responsive), then suppresses further callbacks until an
   * intervening run of {@link streamingSilenceResetFrames} consecutive silence
   * frames re-arms the gate. This mirrors how the batch {@link MediaTurnDetector}
   * debounces `onTurnStart` to once per turn.
   *
   * @param hasSpeech - Whether the current 20 ms frame contains speech.
   */
  private noteStreamingSpeechActivity(hasSpeech: boolean): void {
    if (hasSpeech) {
      this.streamingSilenceFrames = 0;
      if (!this.streamingSpeechActive) {
        // Rising edge: start of a new speech turn. Fire once.
        this.streamingSpeechActive = true;
        this.callbacks.onSpeechStart?.();
      }
      return;
    }

    // Silence frame: count toward the reset threshold while a turn is active.
    if (this.streamingSpeechActive) {
      this.streamingSilenceFrames++;
      if (this.streamingSilenceFrames >= this.streamingSilenceResetFrames) {
        // Silence gap long enough to close the turn — re-arm the gate so the
        // next speech frame fires onSpeechStart again.
        this.streamingSpeechActive = false;
        this.streamingSilenceFrames = 0;
      }
    }
  }

  /**
   * Feed a single inbound media frame through the batch pipeline: compute
   * speech activity from the audio payload using a lightweight energy
   * heuristic, drive the turn detector, and accumulate the chunk.
   *
   * The detector call runs BEFORE the push so that the onTurnStart callback
   * can clear stale inter-turn silence from the buffer without also wiping the
   * first speech chunk of the new turn.
   */
  private feedBatch(base64Payload: string): void {
    const hasSpeech = detectSpeechActivity(base64Payload);
    this.turnDetector.onMediaChunk(hasSpeech);
    this.currentTurnChunks.push(base64Payload);
  }

  /**
   * Append a raw payload to the bounded streaming startup buffer, dropping
   * oldest frames (and counting them) rather than growing unbounded.
   */
  private bufferStartupFrame(base64Payload: string): void {
    this.streamingStartupBuffer.push(base64Payload);
    while (this.streamingStartupBuffer.length > MAX_STREAMING_STARTUP_FRAMES) {
      this.streamingStartupBuffer.shift();
      this.streamingStartupFramesDropped++;
    }
  }

  /**
   * Decode a base64 mu-law payload into resampled PCM16 ready for the
   * streaming transcriber, or `null` if the payload is empty/undecodable.
   */
  private decodeForStreaming(base64Payload: string): Buffer | null {
    let mulaw: Buffer;
    try {
      mulaw = Buffer.from(base64Payload, "base64");
    } catch {
      return null;
    }
    if (mulaw.length === 0) return null;

    const pcm8k = mulawToPcm16(mulaw);
    return resamplePcm16(pcm8k, TELEPHONY_SAMPLE_RATE, STREAMING_SAMPLE_RATE);
  }

  private handleStop(): void {
    // Treat the streaming transcriber as live ONLY when the mode has fully
    // committed to `"streaming"`. While `"streaming-pending"`, the transcriber
    // object may already be set (resolver returned, but `start()` is still
    // awaiting the provider handshake) — taking the "live" branch there would
    // stop()/onStop() and return WITHOUT replaying streamingStartupBuffer to
    // batch, losing the caller's final utterance on short calls / slow
    // handshakes.
    if (this.mode === "streaming") {
      // Streaming mode: signal end-of-audio. The transcriber may emit a
      // final transcript and then a `closed` event (which drives onStop).
      this.streamingTranscriber?.stop();
      this.callbacks.onStop?.();
      return;
    }

    if (this.mode === "streaming-pending") {
      // Stop arrived before the streaming startup settled (resolver pending,
      // or resolver returned but `start()` still in flight). The buffered
      // startup frames live only in streamingStartupBuffer and have not
      // reached the turn detector. Abort the in-flight streaming startup so a
      // late-resolved transcriber does not resurrect streaming, and replay
      // those frames through the batch path so the caller's final utterance is
      // transcribed instead of lost.
      this.streamingAborted = true;
      this.fallBackToBatch();
    }

    // Batch path: finalize any in-flight turn.
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
 * @param base64Payload - Base64-encoded mu-law audio chunk from Twilio.
 * @returns `true` if the chunk likely contains speech, `false` otherwise.
 */
function detectSpeechActivity(base64Payload: string): boolean {
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
