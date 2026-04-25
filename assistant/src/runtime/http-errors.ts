/**
 * Standard HTTP error response format for all /v1/* endpoints.
 *
 * Provides a consistent error shape and helper for building error responses.
 * Existing routes can be migrated incrementally — this module defines the
 * canonical format without breaking current behavior.
 */

// ── Error codes ──────────────────────────────────────────────────────────────

/**
 * Well-known HTTP error codes for the runtime API.
 *
 * These are wire-protocol identifiers (stable, client-facing strings) — not
 * to be confused with `ErrorCode` from `util/errors.ts`, which is for
 * internal assistant-layer errors.
 */
export type HttpErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GONE"
  | "RATE_LIMITED"
  | "UNPROCESSABLE_ENTITY"
  | "FAILED_DEPENDENCY"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "SERVICE_UNAVAILABLE";

// ── Response type ────────────────────────────────────────────────────────────

/**
 * The standard error envelope returned by all /v1/* endpoints.
 *
 * ```json
 * {
 *   "error": {
 *     "code": "BAD_REQUEST",
 *     "message": "conversationKey is required",
 *     "details": { ... }          // optional, endpoint-specific
 *   }
 * }
 * ```
 */
export interface HttpErrorResponse {
  error: {
    code: HttpErrorCode;
    message: string;
    details?: unknown;
  };
}

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a `Response` with the standard error envelope.
 *
 * @param code    A stable, machine-readable error code from `HttpErrorCode`.
 * @param message A human-readable description of the error.
 * @param status  The HTTP status code (e.g. 400, 404, 500).
 * @param details Optional structured payload with endpoint-specific context.
 */
export function httpError(
  code: HttpErrorCode,
  message: string,
  status: number,
  details?: unknown,
): Response {
  const body: HttpErrorResponse = {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return Response.json(body, { status });
}

/**
 * Derive the appropriate `HttpErrorCode` from an HTTP status code.
 * Useful when domain functions return a numeric status and a generic error
 * message — this maps the status to a semantically correct error code.
 */
export function httpErrorCodeFromStatus(status: number): HttpErrorCode {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 410:
      return "GONE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 424:
      return "FAILED_DEPENDENCY";
    case 429:
      return "RATE_LIMITED";
    case 501:
      return "NOT_IMPLEMENTED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL_ERROR";
  }
}
