/**
 * Per-call adaptive silence-threshold calibrator.
 *
 * Collects intra-turn pause durations (speech resuming after a silence gap
 * within the same caller utterance) and derives a p75-based threshold for
 * `MediaTurnDetector.setSilenceThresholdMs`. The calibrated threshold grows
 * to accommodate users who pause mid-thought and shrinks for users who speak
 * in short rapid bursts, converging toward the caller's natural rhythm after
 * a handful of turns.
 *
 * Bounds keep the threshold in a sensible range:
 * - Floor (400 ms) prevents cutting off speakers faster than any human
 *   naturally expects.
 * - Ceiling (1 500 ms) prevents calls feeling unresponsive for callers who
 *   pause very long between phrases.
 *
 * The calibrator is stateless across calls: construct one per
 * `MediaStreamSttSession` and discard it with the session.
 */

/** Minimum silence threshold the calibrator will ever return. */
export const CALIBRATED_MIN_THRESHOLD_MS = 400;

/** Maximum silence threshold the calibrator will ever return. */
export const CALIBRATED_MAX_THRESHOLD_MS = 1500;

/** Minimum samples required before the calibrated value overrides the default. */
const MIN_SAMPLES = 5;

export class SilenceThresholdCalibrator {
  private readonly samples: number[] = [];
  private readonly defaultThresholdMs: number;

  constructor(defaultThresholdMs: number) {
    this.defaultThresholdMs = defaultThresholdMs;
  }

  /** Record one intra-turn pause observation. */
  addSample(pauseMs: number): void {
    this.samples.push(pauseMs);
  }

  /** Number of observations collected so far. */
  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Return the calibrated threshold, or the default when fewer than
   * `MIN_SAMPLES` observations have been collected.
   *
   * Uses the 75th-percentile of observed intra-turn pauses so the threshold
   * covers most thinking pauses while ignoring occasional long outliers.
   */
  calibrate(): number {
    if (this.samples.length < MIN_SAMPLES) {
      return this.defaultThresholdMs;
    }
    const p75 = percentile75(this.samples);
    return clamp(p75, CALIBRATED_MIN_THRESHOLD_MS, CALIBRATED_MAX_THRESHOLD_MS);
  }
}

function percentile75(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.75) - 1;
  return sorted[Math.max(0, idx)]!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
