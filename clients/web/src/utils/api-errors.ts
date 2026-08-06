/**
 * Shared API error normalisation utilities.
 *
 * Both `assistants/api.ts` and `chat/api.ts` need to turn unknown API error
 * payloads into a predictable shape.  This module centralises that logic so
 * every API layer behaves the same way.
 */

/**
 * Coerce an unknown API error payload into a plain object.
 *
 * - Objects are returned as-is.
 * - Strings are wrapped as `{ detail: <string> }`.
 * - Everything else falls back to `{ detail: response.statusText }` or a
 *   generic message.
 */
export function toErrorObject(
  error: unknown,
  response?: Response,
): Record<string, unknown> {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return error as Record<string, unknown>; // narrowed from `object`
  }

  if (typeof error === "string" && !error.trimStart().startsWith("<")) {
    return {
      detail: error.slice(0, 500) || response?.statusText || "Request failed.",
    };
  }

  return { detail: response?.statusText || "Request failed." };
}

/**
 * Extract a human-readable error message from an API error payload.
 *
 * Tries common fields (`detail`, `error`, `error.message`, `message`) before
 * falling back to the HTTP status or a generic string.
 */
export function extractErrorMessage(
  error: unknown,
  response?: Response,
  fallback?: string,
): string {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    if ("detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
    if ("error" in error) {
      if (typeof error.error === "string") {
        return error.error;
      }
      if (
        error.error &&
        typeof error.error === "object" &&
        "message" in error.error &&
        typeof error.error.message === "string"
      ) {
        return error.error.message;
      }
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
  }

  if (
    typeof error === "string" &&
    error &&
    !error.trimStart().startsWith("<")
  ) {
    return error;
  }

  return fallback ?? (response ? `HTTP ${response.status}` : "Request failed.");
}

/**
 * Assert that a `Response` object is present.
 *
 * HeyAPI SDK calls return `{ data, error, response }` where `response` can be
 * `undefined` when the request never reached the server (e.g. network error).
 * This helper narrows the type and throws a descriptive error when it is
 * missing.
 */
export function assertHasResponse(
  response: Response | undefined,
  error: unknown,
  fallbackMessage: string,
): asserts response is Response {
  if (response) {
    return;
  }

  if (error instanceof Error) {
    throw error;
  }

  throw new Error(fallbackMessage);
}

/**
 * Error class that carries the HTTP status code from API responses.
 * Callers can inspect `status` to show context-specific UI (e.g. 401 vs 500).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * The server's own message for a 400 rejection, or `undefined` for any other
 * failure. A 400 from the daemon is a validation verdict written for the user
 * ("Anthropic has no API key…") and is worth more than generic retry copy;
 * every other status carries internal detail, so callers keep their own
 * wording there.
 *
 * Only matches {@link ApiError}, which the daemon client's error interceptor
 * produces for `throwOnError: true` calls — its `message` is already the
 * server's `error.message` when the body carried one. The synthesized
 * `HTTP <status>` fallback is treated as no message at all.
 */
export function badRequestMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return undefined;
  }
  const message = error.message.trim();
  if (message.length === 0 || /^HTTP \d+$/.test(message)) {
    return undefined;
  }
  return message;
}

/**
 * Wrap a non-OK response and its raw error body into a status-carrying
 * {@link ApiError}. The daemon client's error interceptor uses this, and so do
 * `throwOnError: false` reads that bypass that interceptor but still need the
 * thrown error to carry the HTTP status the global retry predicate inspects.
 */
export function toApiError(error: unknown, response: Response): ApiError {
  return new ApiError(
    response.status,
    extractErrorMessage(error, response, `HTTP ${response.status}`),
  );
}
