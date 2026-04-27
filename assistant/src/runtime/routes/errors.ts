/**
 * Transport-agnostic route errors.
 *
 * Handlers in the shared ROUTES array throw these instead of returning
 * HTTP responses. Each transport adapter maps them to the appropriate
 * wire format — the HTTP adapter converts them to status codes, the IPC
 * adapter can return structured error objects, etc.
 */

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export class BadRequestError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class FailedDependencyError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "FailedDependencyError";
  }
}

export class ServiceUnavailableError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
