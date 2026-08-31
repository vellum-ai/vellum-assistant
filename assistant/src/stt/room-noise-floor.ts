/**
 * Rolling estimate of a room's continuous background noise level, on the same
 * 16-bit mean-absolute-amplitude scale as `speech-energy.ts`.
 *
 * ## Why an estimate is needed at all
 *
 * `detectPcm16SpeechActivity` compares a chunk against a fixed absolute
 * threshold. A constant works only if every room delivers roughly the same
 * silence, and rooms do not: a quiet home office and a cafe differ by more
 * than the gap between silence and speech. Set the constant for the cafe and a
 * soft talker is never heard; set it for the office and the cafe's background
 * reads as continuous speech, which in a live-voice session means room noise
 * repeatedly cancels the assistant mid-reply.
 *
 * ## Why the minimum of block means, and not an average
 *
 * The hard part is estimating background noise from a signal that also
 * contains the user. Averaging fails: it folds the user's own speech into the
 * floor, so the floor climbs while they talk and the gate goes deaf exactly
 * when someone is using it. An envelope with a slow time constant fails the
 * same way for the same reason, because "a person talking" and "a noisier
 * room" both last about as long as each other, and a time constant cannot
 * separate two things that differ only in level.
 *
 * What does separate them is that **speech is intermittent and room noise is
 * continuous.** Any ten seconds of a real conversation contains at least one
 * second in which nobody is speaking, and in that second the microphone hears
 * the room and nothing else. So: average within a one-second block, then take
 * the *minimum* across the retained blocks. Block-averaging first matters,
 * because a minimum taken over raw chunks would latch onto the quietest 50 ms
 * gap between two syllables, which is a pause inside speech, not the room.
 *
 * The estimate degrades honestly rather than dangerously. Ten unbroken seconds
 * of speech (a monologue with no breath) raises the floor, because there was
 * genuinely no quiet second to measure; it recovers on the first pause. The
 * caller bounds what a raised floor is allowed to do.
 *
 * Pure and transport-neutral: amplitudes in, an estimate out, no session or
 * provider state.
 */

/** Audio duration averaged into one block before it joins the estimate. */
export const NOISE_FLOOR_BLOCK_MS = 1_000;

/**
 * Completed blocks retained. Ten seconds is the shortest window that reliably
 * contains a conversational pause, and short enough that walking somewhere
 * quieter is reflected within a turn or two.
 */
export const NOISE_FLOOR_BLOCK_COUNT = 10;

/**
 * Tracks the quietest recent second of microphone audio.
 *
 * Feed it every chunk's mean amplitude while the near end is *not* playing
 * audio back; feeding it during playback would teach it the assistant's own
 * echo. Call {@link interrupt} when observation stops for that reason, so a
 * block never averages across the gap.
 */
export class RoomNoiseFloor {
  private readonly blockMs: number;
  private readonly blockCount: number;
  /** Completed block means, oldest first, at most `blockCount` of them. */
  private readonly blocks: number[] = [];
  /** Duration-weighted amplitude sum of the block being filled. */
  private pendingWeightedSum = 0;
  private pendingMs = 0;

  constructor(
    blockMs: number = NOISE_FLOOR_BLOCK_MS,
    blockCount: number = NOISE_FLOOR_BLOCK_COUNT,
  ) {
    this.blockMs = blockMs;
    this.blockCount = blockCount;
  }

  /**
   * Fold one chunk's mean amplitude into the estimate.
   *
   * Weighted by duration so an irregular chunk size cannot skew a block: the
   * client's framing is its own business, and a 10 ms tail must not count as
   * much as the 50 ms frame before it.
   */
  observe(meanAmplitude: number, durationMs: number): void {
    if (!(durationMs > 0) || !Number.isFinite(meanAmplitude)) {
      return;
    }
    this.pendingWeightedSum += meanAmplitude * durationMs;
    this.pendingMs += durationMs;
    if (this.pendingMs < this.blockMs) {
      return;
    }
    this.blocks.push(this.pendingWeightedSum / this.pendingMs);
    if (this.blocks.length > this.blockCount) {
      this.blocks.shift();
    }
    this.pendingWeightedSum = 0;
    this.pendingMs = 0;
  }

  /**
   * Drop the partially-filled block, keeping everything already completed.
   *
   * Call this when observation is about to pause (assistant playback starting)
   * or resume after a gap. Without it a single block could average a half
   * second of room from before the gap with a half second from after it, which
   * is a measurement of neither.
   */
  interrupt(): void {
    this.pendingWeightedSum = 0;
    this.pendingMs = 0;
  }

  /**
   * The quietest retained second, or `null` until the window is **full**.
   *
   * Waiting for a full window is what makes the minimum safe. Over ten seconds
   * the claim "at least one of these seconds contains no speech" holds; over
   * one second it does not, and a partial window would happily report the first
   * second of a sentence as the room's noise floor. That over-estimate is the
   * dangerous direction: it raises the gate against the very voice it measured.
   *
   * `null` means "no opinion yet" and callers must fall back to their
   * configured constant rather than treating it as a floor of zero. Since only
   * non-playback audio is observed, the window fills with accumulated listening
   * time rather than wall clock, which in a real session is a turn or two.
   */
  get floor(): number | null {
    if (this.blocks.length < this.blockCount) {
      return null;
    }
    return Math.min(...this.blocks);
  }

  /** Forget everything, e.g. when the input route changes under the session. */
  reset(): void {
    this.blocks.length = 0;
    this.interrupt();
  }
}
