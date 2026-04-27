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

export class NotFoundError extends RouteError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
