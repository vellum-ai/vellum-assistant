/**
 * Speech-aware turn detector for segmenting inbound audio from a
 * Twilio Media Stream into discrete utterance "turns".
 *
 * The Twilio ConversationRelay protocol performs VAD (voice activity
 * detection) on Twilio's side and delivers fully segmented transcripts
 * via `prompt` messages. The raw media-stream path, however, delivers a
 * continuous stream of audio chunks with no built-in turn boundaries.
 * This module bridges that gap by detecting turns based on speech
 * activity signals derived from the audio content:
 *
 * 1. **Speech-to-silence transition** — when a period of speech is
 *    followed by silence frames exceeding `silenceThresholdMs`, the
 *    current turn is considered complete.
 * 2. **Max turn duration** — to prevent unbounded accumulation, a turn
 *    is forcibly ended when its total duration exceeds `maxTurnDurationMs`.
 *
 * Continuous inbound media frames (which Twilio sends at a steady
 * cadence regardless of speech) do not prevent turn boundaries. Only
 * frames classified as containing speech reset the silence timer. Turns
 * that never contain a speech-bearing chunk are silently discarded
 * without firing the `onTurnEnd` callback.
 *
 * Design:
 * - Stateful but single-threaded (no locking; runs on the main event loop).
 * - Timer-based silence detection via `setTimeout` / `clearTimeout`.
 * - Integration-neutral: emits callbacks, not wired to any specific
 *   downstream consumer.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TurnDetectorConfig {
  /**
   * Duration of silence (no speech-active chunks) after which the current
   * turn is considered complete. Milliseconds. Default: 800.
   */
  silenceThresholdMs?: number;

  /**
   * Maximum duration of a single turn before it is forcibly ended.
   * Milliseconds. Default: 30_000 (30 seconds).
   */
  maxTurnDurationMs?: number;
}

const DEFAULT_SILENCE_THRESHOLD_MS = 800;
const DEFAULT_MAX_TURN_DURATION_MS = 30_000;

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface TurnDetectorCallbacks {
  /**
   * Called when the detector transitions from idle to active (first
   * speech-bearing chunk of a new turn). Useful for signalling
   * "speech started" upstream.
   */
  onTurnStart?: () => void;

  /**
   * Called when the current turn ends (silence timeout or max duration).
   *
   * @param reason - `"silence"` when the silence timer expired, or
   *   `"max-duration"` when the turn hit the hard cap.
   * @param durationMs - Approximate wall-clock duration of the turn in
   *   milliseconds (from the first speech chunk to the end trigger).
   */
  onTurnEnd?: (reason: "silence" | "max-duration", durationMs: number) => void;
}

// ---------------------------------------------------------------------------
// Turn detector
// ---------------------------------------------------------------------------

export class MediaTurnDetector {
  private readonly silenceThresholdMs: number;
  private readonly maxTurnDurationMs: number;
  private readonly callbacks: TurnDetectorCallbacks;

  /** Whether a turn is currently in progress. */
  private active = false;

  /** Whether any speech-bearing chunk was received during the current turn. */
  private hasSpeechInTurn = false;

  /** Wall-clock timestamp of the first speech chunk in the current turn. */
  private turnStartedAt = 0;

  /** Timer that fires when silence exceeds the threshold. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer that fires when the turn hits max duration. */
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the detector has been disposed. */
  private disposed = false;

  constructor(
    config: TurnDetectorConfig = {},
    callbacks: TurnDetectorCallbacks = {},
  ) {
    this.silenceThresholdMs =
      config.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.maxTurnDurationMs =
      config.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS;
    this.callbacks = callbacks;
  }

  /**
   * Whether a turn is currently in progress (speech has been detected and
   * neither the silence timer nor the max-duration timer has fired yet).
   */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Feed an inbound audio chunk to the detector with speech activity info.
   *
   * Call this for every `media` event received from the Twilio Media
   * Stream. The `hasSpeech` flag indicates whether the chunk contains
   * voice activity (computed by the caller from audio energy analysis).
   *
   * When `hasSpeech` is true:
   * - If idle, starts a new turn (fires onTurnStart).
   * - Resets the silence timer.
   *
   * When `hasSpeech` is false:
   * - If a turn is active, the silence timer continues counting down.
   *   Continuous silent frames do not prevent turn boundaries.
   * - If idle, the chunk is ignored (no turn is started for silence).
   *
   * @param hasSpeech - Whether the audio chunk contains detectable speech.
   *   Defaults to `true` for backwards compatibility with callers that
   *   do not perform energy analysis.
   */
  onMediaChunk(hasSpeech = true): void {
    if (this.disposed) return;

    if (hasSpeech) {
      if (!this.active) {
        // Transition from idle -> active: start a new turn.
        this.active = true;
        this.hasSpeechInTurn = true;
        this.turnStartedAt = Date.now();
        this.callbacks.onTurnStart?.();

        // Arm the max-duration hard cap.
        this.maxDurationTimer = setTimeout(() => {
          this.endTurn("max-duration");
        }, this.maxTurnDurationMs);
      }

      // Reset the silence timer on speech chunks.
      this.resetSilenceTimer();
    } else if (this.active && this.silenceTimer === null) {
      // Active turn but no speech — start the silence countdown if
      // not already running. This handles the transition from speech
      // to silence within a continuous chunk stream.
      this.resetSilenceTimer();
    }
    // Silent chunks while idle are ignored — no turn is started.
  }

  /**
   * Force the current turn to end immediately. No-ops if no turn is active.
   *
   * Callers use this when the stream stops (e.g. `stop` event) so the
   * in-flight turn is properly finalized rather than left dangling.
   */
  forceEnd(): void {
    if (!this.active || this.disposed) return;
    this.endTurn("silence");
  }

  /**
   * Dispose of the detector, clearing all timers. After calling this the
   * detector is inert and `onMediaChunk` / `forceEnd` become no-ops.
   */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.active = false;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private resetSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      if (this.hasSpeechInTurn) {
        this.endTurn("silence");
      } else {
        // No speech was detected during the turn — reset state without
        // emitting a turn-end callback to avoid bogus empty turns.
        this.clearTimers();
        this.active = false;
      }
    }, this.silenceThresholdMs);
  }

  private endTurn(reason: "silence" | "max-duration"): void {
    if (!this.active) return;

    const durationMs = Date.now() - this.turnStartedAt;

    this.clearTimers();
    this.active = false;
    this.hasSpeechInTurn = false;

    this.callbacks.onTurnEnd?.(reason, durationMs);
  }

  private clearTimers(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.maxDurationTimer !== null) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }
}
