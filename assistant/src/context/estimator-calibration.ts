/**
 * Self-calibrating correction ratios for the token estimator.
 *
 * Every successful provider call returns ground-truth `usage.inputTokens`.
 * By comparing that to the pre-send estimate, we can maintain a per-model
 * EWMA correction ratio that multiplies future estimates — catching
 * miscalibration proactively instead of waiting for provider overflow
 * errors to reverse-engineer a token count from the error message.
 *
 * State is process-local; correction resets on restart. That is acceptable
 * because the ratio converges quickly (EWMA alpha = 0.2, ~5 samples).
 */

interface CalibrationState {
  /** EWMA of (actual / estimated) — multiply estimates by this to correct. */
  ratio: number;
  /** Total samples recorded, for observability. */
  sampleCount: number;
}

const CALIBRATIONS: Map<string, CalibrationState> = new Map();

/** Fast-adapting EWMA — converges to a steady state in ~5 consistent samples. */
const EWMA_ALPHA = 0.2;

/**
 * Below this magnitude both numbers are noisy — a 500-token prompt with a
 * 600-token usage is within normal overhead fluctuation and should not
 * move the correction ratio.
 */
const MIN_SAMPLE_MAGNITUDE = 500;

/**
 * Outlier guard — discard samples where the ratio is more than 3x off in
 * either direction. A ratio that extreme is almost always a bug (wrong
 * estimate site, wrong provider, double-counting) rather than a genuine
 * estimation error the calibrator should learn from.
 */
const MIN_ACCEPTABLE_RATIO = 1 / 3;
const MAX_ACCEPTABLE_RATIO = 3;

function key(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/**
 * Fold a new (estimated, actual) observation into the EWMA ratio for this
 * (provider, model). No-op when either number is too small to be reliable,
 * or when the ratio is an outlier.
 */
export function recordEstimate(
  provider: string,
  model: string,
  estimated: number,
  actual: number,
): void {
  if (estimated < MIN_SAMPLE_MAGNITUDE || actual < MIN_SAMPLE_MAGNITUDE) return;
  const ratio = actual / estimated;
  if (ratio < MIN_ACCEPTABLE_RATIO || ratio > MAX_ACCEPTABLE_RATIO) return;

  const k = key(provider, model);
  const prev = CALIBRATIONS.get(k);
  const next: CalibrationState = prev
    ? {
        ratio: prev.ratio + EWMA_ALPHA * (ratio - prev.ratio),
        sampleCount: prev.sampleCount + 1,
      }
    : { ratio, sampleCount: 1 };
  CALIBRATIONS.set(k, next);
}

/**
 * Correction factor to multiply a raw estimate by. Defaults to 1.0 for any
 * unseen (provider, model) tuple, so first-call behavior is unchanged.
 */
export function getCorrection(provider: string, model: string): number {
  return CALIBRATIONS.get(key(provider, model))?.ratio ?? 1.0;
}

/** Test helper — clears all calibration state. */
export function resetCalibrations(): void {
  CALIBRATIONS.clear();
}

/** Observability — list current calibrations for logging/debugging. */
export function getCalibrationSnapshot(): Array<{
  provider: string;
  model: string;
  ratio: number;
  samples: number;
}> {
  const out: Array<{
    provider: string;
    model: string;
    ratio: number;
    samples: number;
  }> = [];
  for (const [k, state] of CALIBRATIONS) {
    const [provider, model] = k.split("::", 2) as [string, string];
    out.push({
      provider,
      model,
      ratio: state.ratio,
      samples: state.sampleCount,
    });
  }
  return out;
}
