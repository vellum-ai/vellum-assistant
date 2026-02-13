/**
 * Shared error model for both HTTP and IPC transports.
 *
 * HTTP maps `status` to the response status code.
 * IPC serializes the entire error in a ServerMessage.
 */

export interface HandlerError {
  /** HTTP status code (200, 400, 404, 500, etc.) */
  status: number;
  /** Machine-readable error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Optional additional details */
  details?: Record<string, unknown>;
}

export class HandlerException extends Error {
  constructor(
    public readonly error: HandlerError,
  ) {
    super(error.message);
    this.name = 'HandlerException';
  }
}

/**
 * Helper to create a HandlerError for common cases.
 */
export function createError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HandlerError {
  return { status, code, message, details };
}

/**
 * Pre-defined error factories.
 */
export const Errors = {
  badRequest: (message: string, details?: Record<string, unknown>) =>
    createError(400, 'BAD_REQUEST', message, details),

  notFound: (resource: string) =>
    createError(404, 'NOT_FOUND', `${resource} not found`),

  conflict: (message: string) =>
    createError(409, 'CONFLICT', message),

  serviceUnavailable: (message: string) =>
    createError(503, 'SERVICE_UNAVAILABLE', message),

  internalError: (message: string) =>
    createError(500, 'INTERNAL_ERROR', message),
};
