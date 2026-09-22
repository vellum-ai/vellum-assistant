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
 * These are wire-protocol identifiers (stable, client-facing strings), not to
 * be confused with `ErrorCode` from `util/errors.ts`, which is for internal
 * assistant-layer errors.
 *
 * The union covers every `code` a `RouteError` subclass in `routes/errors.ts`
 * carries. A `RouteError` constructed directly names its own code, which the
 * union need not hold, so the adapters' `err.code as HttpErrorCode` is a wire
 * passthrough rather than a checked narrowing.
 */
export type HttpErrorCode =
  | "BAD_REQUEST"
  | "CREDENTIAL_IN_USE"
  | "UNAUTHORIZED"
  | "PAYMENT_REQUIRED"
  | "FORBIDDEN"
  | "LLM_REQUEST_LOGS_DISABLED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "GONE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RANGE_NOT_SATISFIABLE"
  | "BINARY_UNSUPPORTED_OVER_IPC"
  | "RATE_LIMITED"
  | "UNPROCESSABLE_ENTITY"
  | "FAILED_DEPENDENCY"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "BAD_GATEWAY"
  | "UPSTREAM_PROVIDER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_TIMEOUT";

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
