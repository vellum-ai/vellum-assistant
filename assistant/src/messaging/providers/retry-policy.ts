/**
 * Shared retry policy for direct channel delivery.
 *
 * The provider API clients (`telegram-bot`, `whatsapp`, `discord`) each own
 * their request and error shapes, but agree on when a failed call is worth
 * repeating and how long to wait first. Those two decisions live here so a
 * change to backoff or to the retryable-status set reaches every channel.
 */

/**
 * `setTimeout` clamps above this, so a longer delay would fire immediately
 * instead of waiting. Any server-advertised wait is capped to it.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Whether a failed response is worth repeating: a rate limit, or a server-side
 * fault. Every 4xx below 429 describes the request itself, which a retry
 * reproduces exactly.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Milliseconds to wait before the next attempt.
 *
 * A server-advertised wait wins, in either documented `Retry-After` form: a
 * count of seconds, or an HTTP date to wait until. Without one the delay is
 * exponential in the attempt number with jitter, so concurrent callers that
 * failed together do not resume together.
 *
 * `maxDelayMs` bounds the server-advertised branch. It defaults to the timer
 * ceiling; a caller holding a lock across the wait should pass something far
 * smaller and let its own retry machinery own the rest.
 */
export function computeRetryDelayMs(
  attempt: number,
  initialBackoffMs: number,
  retryAfter: string | null,
  maxDelayMs: number = MAX_TIMER_DELAY_MS,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, maxDelayMs);
    }
    const targetTime = new Date(retryAfter).getTime();
    if (Number.isFinite(targetTime)) {
      const delayMs = targetTime - Date.now();
      if (delayMs > 0) {
        return Math.min(delayMs, maxDelayMs);
      }
    }
  }
  const exponential = initialBackoffMs * 2 ** (attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}
