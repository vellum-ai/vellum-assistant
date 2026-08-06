import type pino from "pino";
import type { ConfigFileCache } from "../config-file-cache.js";

/** Retryable HTTP statuses: rate limiting and server-side failures. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Max 32-bit signed int, the setTimeout ceiling. */
const MAX_RETRY_DELAY_MS = 2_147_483_647;

/**
 * Delay before the next retry attempt (1-based).
 *
 * A Retry-After hint takes precedence: numeric seconds (e.g. "120") or an
 * HTTP-date (e.g. "Fri, 31 Dec 1999 23:59:59 GMT"), clamped to the setTimeout
 * ceiling. Without a usable hint, exponential backoff from initialBackoffMs
 * with additive jitter of 0-50%.
 */
export function computeRetryDelayMs(
  attempt: number,
  initialBackoffMs: number,
  retryAfterHeader: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const targetTime = new Date(retryAfterHeader).getTime();
    if (Number.isFinite(targetTime)) {
      const delayMs = targetTime - Date.now();
      if (delayMs > 0) {
        return Math.min(delayMs, MAX_RETRY_DELAY_MS);
      }
    }
  }

  const exponential = initialBackoffMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

/**
 * Provider-specific hooks for {@link retryableFetch}. Error shaping (message
 * text, error classes, secret redaction) stays in the provider module; the
 * loop only decides when to retry and how long to wait.
 */
export interface RetryableFetchHooks<T> {
  /**
   * Sanitized one-line summary of a network-level fetch failure, used in the
   * recorded error and warning log. Defaults to the error's message.
   */
  summarizeFetchError?: (err: unknown) => string;
  /**
   * Handle a non-retryable, non-ok response (4xx other than 429). Must throw
   * the provider's terminal error.
   */
  throwTerminal: (response: Response) => Promise<never>;
  /**
   * Error record and Retry-After hint for a retryable (429/5xx) response.
   * retryAfter feeds the next attempt's delay; null falls back to exponential
   * backoff. The error is thrown if this attempt was the last.
   */
  describeRetryable: (
    response: Response,
  ) => Promise<{ error: Error; retryAfter: string | null }>;
  /** Parse a successful response into the return value. */
  parseSuccess: (response: Response) => Promise<T>;
}

export interface RetryableFetchOptions {
  /** Provider name for log and error text, e.g. "Telegram". */
  provider: string;
  /** API method/operation name for log fields and error text. */
  operation: string;
  log: pino.Logger;
  configFile: ConfigFileCache | undefined;
  /** Config section holding maxRetries / initialBackoffMs. */
  configSection: string;
  doFetch: () => Promise<Response>;
}

/**
 * Fetch with retries on network errors, 429, and 5xx. Retry pacing honors the
 * provider's Retry-After hint via {@link computeRetryDelayMs}; maxRetries
 * (default 3) and initialBackoffMs (default 1000) come from the provider's
 * config section.
 */
export async function retryableFetch<T>(
  options: RetryableFetchOptions,
  hooks: RetryableFetchHooks<T>,
): Promise<T> {
  const { provider, operation, log, configFile, configSection, doFetch } =
    options;
  const maxRetries = configFile?.getNumber(configSection, "maxRetries") ?? 3;
  const initialBackoffMs =
    configFile?.getNumber(configSection, "initialBackoffMs") ?? 1000;

  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeRetryDelayMs(
        attempt,
        initialBackoffMs,
        lastRetryAfter,
      );
      log.debug({ attempt, delay, operation }, `Retrying ${provider} API call`);
      await new Promise((r) => setTimeout(r, delay));
    }

    lastRetryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const summary = hooks.summarizeFetchError
        ? hooks.summarizeFetchError(err)
        : err instanceof Error
          ? err.message
          : String(err);
      lastError = new Error(
        `${provider} ${operation} request failed: ${summary}`,
      );
      log.warn(
        { error: summary, attempt, operation },
        `${provider} API fetch failed`,
      );
      continue;
    }

    if (isRetryableHttpStatus(response.status)) {
      const { error, retryAfter } = await hooks.describeRetryable(response);
      lastRetryAfter = retryAfter;
      lastError = error;
      log.warn(
        { status: response.status, attempt, operation, retryAfter },
        `${provider} API returned retryable error`,
      );
      continue;
    }

    if (!response.ok) {
      return hooks.throwTerminal(response);
    }

    return hooks.parseSuccess(response);
  }

  throw lastError ?? new Error(`${provider} ${operation} failed after retries`);
}
