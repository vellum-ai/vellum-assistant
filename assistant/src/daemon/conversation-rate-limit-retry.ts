import { ProviderError } from "../util/errors.js";
import {
  abortableSleep,
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  extractRetryAfterMs,
} from "../util/retry.js";
import type { ClassifiedConversationError } from "./conversation-error.js";

/**
 * Cap server-suggested waits so a pathological Retry-After cannot stall a turn.
 * Matches the provider-layer retry cap in `providers/retry.ts`.
 */
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 60_000;

/**
 * Whether a classified agent-loop error should trigger an automatic
 * rate-limit retry. Only `PROVIDER_RATE_LIMIT` with `retryable=true` is
 * eligible, and only while the abort signal is idle and retry budget remains.
 */
export function shouldRetryProviderRateLimit(
  classified: ClassifiedConversationError,
  args: {
    attempt: number;
    signal?: AbortSignal;
    maxRetries?: number;
  },
): boolean {
  if (args.signal?.aborted) {
    return false;
  }
  if (classified.code !== "PROVIDER_RATE_LIMIT" || !classified.retryable) {
    return false;
  }
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  return args.attempt < maxRetries;
}

function headersFromUnknown(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("headers" in value)) {
    return undefined;
  }
  return (value as { headers?: unknown }).headers;
}

/**
 * Delay before the next rate-limit retry. Prefers a provider-stamped
 * `retryAfterMs`, then a Retry-After header on the error or its cause,
 * then exponential backoff with jitter.
 */
export function resolveRateLimitRetryDelay(
  error: unknown,
  attempt: number,
): number {
  const fromProvider =
    error instanceof ProviderError ? error.retryAfterMs : undefined;
  const fromHeaders = extractRetryAfterMs(headersFromUnknown(error));
  const fromCause =
    error instanceof Error
      ? extractRetryAfterMs(headersFromUnknown(error.cause))
      : undefined;
  const retryAfterMs = fromProvider ?? fromHeaders ?? fromCause;
  const delay =
    retryAfterMs !== undefined
      ? retryAfterMs
      : computeRetryDelay(attempt, DEFAULT_BASE_DELAY_MS);
  return Math.min(Math.max(0, delay), MAX_RATE_LIMIT_RETRY_DELAY_MS);
}

/**
 * Wait out a rate-limit backoff, resolving early if `signal` aborts so the
 * caller can treat it as a cancellation rather than a failed retry.
 */
export async function sleepForRateLimitRetry(
  error: unknown,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  await abortableSleep(resolveRateLimitRetryDelay(error, attempt), signal);
}

export { DEFAULT_MAX_RETRIES, MAX_RATE_LIMIT_RETRY_DELAY_MS };
