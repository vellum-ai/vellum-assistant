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

export class UnauthorizedError extends RouteError {
  constructor(message: string) {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class BadRequestError extends RouteError {
  constructor(message: string) {
    super(message, "BAD_REQUEST", 400);
    this.name = "BadRequestError";
  }
}

export class TooManyRequestsError extends RouteError {
  constructor(message: string) {
    super(message, "RATE_LIMITED", 429);
    this.name = "TooManyRequestsError";
  }
}

export class ForbiddenError extends RouteError {
  constructor(message: string) {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
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

export class BadGatewayError extends RouteError {
  constructor(message: string) {
    super(message, "BAD_GATEWAY", 502);
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends RouteError {
  constructor(message: string) {
    super(message, "SERVICE_UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends RouteError {
  constructor(message: string) {
    super(message, "GATEWAY_TIMEOUT", 504);
    this.name = "GatewayTimeoutError";
  }
}

export class InternalError extends RouteError {
  constructor(message: string) {
    super(message, "INTERNAL_ERROR", 500);
    this.name = "InternalError";
  }
}
