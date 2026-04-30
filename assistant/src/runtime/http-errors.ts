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
