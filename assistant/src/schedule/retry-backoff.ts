export const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Compute retry delay with exponential backoff and jitter.
 * The exponential term is clamped to maxMs BEFORE jitter to prevent
 * Infinity/NaN for large attempt values, and capped again after jitter
 * so the result never exceeds maxMs.
 */
export function computeRetryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number = DEFAULT_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * 0.2 * (2 * random() - 1);
  return Math.max(0, Math.min(Math.round(exponential + jitter), maxMs));
}
