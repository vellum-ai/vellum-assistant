/**
 * Transport-agnostic route errors.
 *
 * Handlers in the shared ROUTES array throw these instead of returning
 * HTTP responses. Each transport adapter maps them to the appropriate
 * wire format — the HTTP adapter uses `statusCode`, the IPC adapter can
 * return structured `{ code, message }` objects, etc.
 */

export class RouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "RouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class BadRequestError extends RouteError {
  constructor(message: string) {
    super(message, "BAD_REQUEST", 400);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends RouteError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends RouteError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class FailedDependencyError extends RouteError {
  constructor(message: string) {
    super(message, "FAILED_DEPENDENCY", 424);
    this.name = "FailedDependencyError";
  }
}

export class ServiceUnavailableError extends RouteError {
  constructor(message: string) {
    super(message, "SERVICE_UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
  }
}
