/**
 * Shared retry behaviour for direct channel delivery.
 *
 * The provider API clients (`telegram-bot`, `whatsapp`, `discord`) differ in
 * how they authenticate, shape errors, and decode a success. They do not
 * differ in how a call is retried: attempt counting, the wait between
 * attempts, which statuses are worth repeating, and which error surfaces when
 * the attempts run out are the same everywhere.
 *
 * That orchestration lives in {@link retryableCall}, and each client supplies
 * only its own I/O shaping. Adding a channel means writing the shaping, not a
 * fourth copy of the loop.
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

// ---------------------------------------------------------------------------
// Retry orchestration
// ---------------------------------------------------------------------------

/** The logging surface `retryableCall` needs, satisfied by `getLogger()`. */
interface RetryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** A failed response, as the caller's error factory sees it. */
export interface RetryableCallFailure {
  status: number;
  /** Message built to the shared shape, already redacted. */
  message: string;
  /** Provider-supplied explanation, when the body carried one. */
  detail: string | undefined;
}

export interface RetryableCall<T> {
  /** Provider label used in messages and logs, e.g. `"Telegram"`. */
  provider: string;
  /** Operation label used in messages and logs: a method name or route. */
  operation: string;
  maxRetries: number;
  initialBackoffMs: number;
  /** Bound on a server-advertised wait. See {@link computeRetryDelayMs}. */
  maxDelayMs?: number;
  log: RetryLogger;
  doFetch: () => Promise<Response>;
  /** Pull the provider's own explanation out of an error body, when it has one. */
  detailFrom?: (body: string) => string | undefined;
  /**
   * A `Retry-After` value the provider carries somewhere other than the
   * header. Returning null falls back to the header.
   */
  retryAfterFrom?: (response: Response, body: string) => string | null;
  /**
   * Sanitize text before it reaches a message or a log line, for providers
   * whose errors can echo a credential back.
   */
  redact?: (value: string) => string;
  /** The error to throw for a response that is not worth repeating. */
  nonRetryableError: (failure: RetryableCallFailure) => Error;
  /** Decode a successful response. The body is read once and passed here. */
  decode: (body: string, response: Response) => T;
}

/**
 * Run a provider API call, repeating it while the failure looks transient.
 *
 * Retryable: rate limits, server faults, and transport errors. Everything else
 * throws immediately, because a retry reproduces the request exactly. When the
 * attempts run out the last failure is thrown rather than a generic one, so
 * the surfaced error describes what actually went wrong.
 */
export async function retryableCall<T>(call: RetryableCall<T>): Promise<T> {
  const {
    provider,
    operation,
    log,
    redact = (value: string) => value,
    detailFrom,
    retryAfterFrom,
  } = call;

  /** The shared message shape, so every channel reads the same in a log. */
  const describe = (
    status: number,
    detail: string | undefined,
    body: string,
  ): string => {
    if (detail) {
      return `${provider} ${operation} failed: ${detail}`;
    }
    return body
      ? `${provider} ${operation} failed with status ${status}: ${redact(body)}`
      : `${provider} ${operation} failed with status ${status}`;
  };

  let lastError: Error | null = null;
  let retryAfter: string | null = null;

  for (let attempt = 0; attempt <= call.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeRetryDelayMs(
        attempt,
        call.initialBackoffMs,
        retryAfter,
        call.maxDelayMs,
      );
      log.debug({ attempt, delay, operation }, `Retrying ${provider} API call`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    retryAfter = null;

    let response: Response;
    try {
      response = await call.doFetch();
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      lastError = new Error(
        `${provider} ${operation} request failed: ${message}`,
      );
      log.warn(
        { error: message, attempt, operation },
        `${provider} API fetch failed`,
      );
      continue;
    }

    // The body is readable once, so it is read here and shared by every branch.
    const body = await response.text().catch(() => "");

    if (response.ok) {
      return call.decode(body, response);
    }

    const detail = detailFrom?.(body);
    const message = describe(response.status, detail, body);

    if (!isRetryableStatus(response.status)) {
      throw call.nonRetryableError({
        status: response.status,
        message,
        detail,
      });
    }

    retryAfter =
      retryAfterFrom?.(response, body) ?? response.headers.get("retry-after");
    lastError = new Error(message);
    log.warn(
      { status: response.status, attempt, operation, retryAfter },
      `${provider} API returned retryable error`,
    );
  }

  throw lastError ?? new Error(`${provider} ${operation} failed after retries`);
}
