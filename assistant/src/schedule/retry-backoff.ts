export const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Compute retry delay with exponential backoff and jitter.
 * Cap is applied AFTER jitter so the result never exceeds maxMs.
 */
export function computeRetryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number = DEFAULT_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = exponential * 0.2 * (2 * random() - 1);
  const raw = exponential + jitter;
  return Math.max(0, Math.min(Math.round(raw), maxMs));
}
