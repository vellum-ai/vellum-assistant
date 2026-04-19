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
export function computeRetryDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): number {
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
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const parsed = parseRetryAfterMs(retryAfter);
    if (parsed !== undefined) return parsed;
  }
  // For attempt 0, double the base so jitter range [baseDelayMs, 2*baseDelayMs) stays above the floor.
  // For attempt >= 1, use the original base — jitter is already above baseDelayMs.
  const effectiveBase = attempt === 0 ? baseDelayMs * 2 : baseDelayMs;
  return Math.max(baseDelayMs, computeRetryDelay(attempt, effectiveBase));
}

/**
 * Whether an HTTP status code is retryable (429 or 5xx).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Message patterns that indicate a retryable network/transport error even
 * when no errno code is present (e.g. Bun's native fetch socket errors).
 */
const RETRYABLE_NETWORK_MESSAGE_PATTERNS = [
  /socket.*closed unexpectedly/i,
  /socket hang up/i,
];

/**
 * Whether an error is a retryable network error (ECONNRESET, ECONNREFUSED, etc.).
 * Checks errno codes on the error and one level of `cause` chain, then falls
 * back to message-based detection for runtime-specific errors (e.g. Bun fetch).
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const retryableCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
  ]);

  const code = (error as NodeJS.ErrnoException).code;
  if (code && retryableCodes.has(code)) return true;

  if (error.cause instanceof Error) {
    const causeCode = (error.cause as NodeJS.ErrnoException).code;
    if (causeCode && retryableCodes.has(causeCode)) return true;
  }

  // Fall back to message-based detection for errors without errno codes
  // (e.g. Bun's "The socket connection was closed unexpectedly")
  if (RETRYABLE_NETWORK_MESSAGE_PATTERNS.some((p) => p.test(error.message))) {
    return true;
  }

  // Also check the cause's message (ProviderError wraps the original message
  // but the cause retains the raw transport-level text)
  const cause = error.cause;
  if (
    cause instanceof Error &&
    RETRYABLE_NETWORK_MESSAGE_PATTERNS.some((p) => p.test(cause.message))
  ) {
    return true;
  }

  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like `sleep` but resolves early when an AbortSignal fires.
 * Resolves (not rejects) on abort so callers can check the signal
 * themselves and decide what to do.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(onDone, ms);
    signal.addEventListener("abort", onDone, { once: true });
    function onDone() {
      clearTimeout(timer);
      signal!.removeEventListener("abort", onDone);
      resolve();
    }
  });
}

/**
 * Extract retry-after milliseconds from an SDK error's headers object.
 * Handles both Map-like (OpenAI: Headers with .get()) and plain-object
 * (Anthropic: Record<string, string>) header shapes.
 */
export function extractRetryAfterMs(headers: unknown): number | undefined {
  if (!headers) return undefined;

  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(k: string): string | null }).get("retry-after");
  } else if (typeof headers === "object") {
    raw = (headers as Record<string, string>)["retry-after"];
  }

  if (typeof raw === "string") {
    return parseRetryAfterMs(raw);
  }
  return undefined;
}

export { DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_RETRIES };
