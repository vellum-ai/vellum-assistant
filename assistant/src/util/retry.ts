/**
 * Shared retry utilities with exponential backoff + jitter.
 *
 * Used by both the provider retry layer (exception-based) and the
 * web-search tool layer (HTTP response-based).
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

export interface RetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000). */
  baseDelayMs?: number;
}

/**
 * Compute a retry delay with equal jitter: guaranteed floor of cap/2
 * plus random in [0, cap/2]. Prevents retry storms while ensuring
 * retries never collapse to 0ms.
 */
export function computeRetryDelay(attempt: number, baseDelayMs = DEFAULT_BASE_DELAY_MS): number {
  const cap = baseDelayMs * Math.pow(2, attempt);
  const half = cap / 2;
  return half + Math.random() * half;
}

/**
 * Parse a Retry-After header value into milliseconds.
 * RFC 7231 allows either delta-seconds (e.g. "120") or an HTTP-date
 * (e.g. "Tue, 17 Feb 2026 12:00:00 GMT"). Returns undefined if unparseable.
 */
export function parseRetryAfterMs(value: string): number | undefined {
  const seconds = Number(value);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }
  // Try HTTP-date format — Date.parse handles RFC 2822 / IMF-fixdate
  const dateMs = Date.parse(value);
  if (!isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Determine the retry delay for an HTTP response. Uses the Retry-After
 * header if present, otherwise falls back to exponential backoff with jitter.
 */
export function getHttpRetryDelay(
  response: Response,
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const parsed = parseRetryAfterMs(retryAfter);
    if (parsed !== undefined) return parsed;
  }
  // Double the base so that computeRetryDelay's equal-jitter range on attempt 0
  // becomes [baseDelayMs, baseDelayMs*2) — above the floor AND with jitter preserved.
  // Without the *2, Math.max clamps attempt-0 to exactly baseDelayMs (no jitter),
  // causing all clients to retry simultaneously (thundering herd).
  return Math.max(baseDelayMs, computeRetryDelay(attempt, baseDelayMs * 2));
}

/**
 * Whether an HTTP status code is retryable (429 or 5xx).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Whether an error is a retryable network error (ECONNRESET, ECONNREFUSED, etc.).
 * Checks both the error itself and one level of `cause` chain.
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const retryableCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);

  const code = (error as NodeJS.ErrnoException).code;
  if (code && retryableCodes.has(code)) return true;

  if (error.cause instanceof Error) {
    const causeCode = (error.cause as NodeJS.ErrnoException).code;
    if (causeCode && retryableCodes.has(causeCode)) return true;
  }

  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS };
