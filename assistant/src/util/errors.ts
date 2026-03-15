export enum ErrorCode {
  // Provider errors
  PROVIDER_ERROR = "PROVIDER_ERROR",

  // Tool errors
  TOOL_ERROR = "TOOL_ERROR",

  // Permission errors
  PERMISSION_DENIED = "PERMISSION_DENIED",

  // Config errors
  CONFIG_ERROR = "CONFIG_ERROR",

  // Daemon errors
  DAEMON_ERROR = "DAEMON_ERROR",

  // Platform-specific errors (clipboard, unsupported OS features)
  PLATFORM_ERROR = "PLATFORM_ERROR",

  // WASM integrity check failures
  INTEGRITY_ERROR = "INTEGRITY_ERROR",

  // Secret detected in inbound content
  INGRESS_BLOCKED = "INGRESS_BLOCKED",

  // Internal/unexpected errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

// ── Root ──────────────────────────────────────────────────────────────────────

/** Root base class for all named Vellum errors. */
export class VellumError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VellumError";
  }
}

// ── Backend errors ────────────────────────────────────────────────────────────

/**
 * Errors originating from infrastructure or external service calls.
 * Catch this when you want to handle any backend failure uniformly.
 */
export class BackendError extends VellumError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendError";
  }
}

/**
 * The embedding or vector-search backend is not configured or not reachable.
 * Thrown before attempting an embedding operation so callers can skip or defer.
 */
export class BackendUnavailableError extends BackendError {
  constructor(reason: string) {
    super(reason);
    this.name = "BackendUnavailableError";
  }
}

/**
 * A request or token-budget quota was exceeded.
 * Thrown by the provider rate-limiter and by domain-specific clients (e.g. DoorDash).
 */
export class RateLimitError extends BackendError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ── User errors ───────────────────────────────────────────────────────────────

/**
 * Errors caused by user input, policy violations, or user-facing constraints.
 * Catch this when you want to present an actionable message to the user.
 */
export class UserError extends VellumError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserError";
  }
}

// ── AssistantError subtree ────────────────────────────────────────────────────

/**
 * Base class for errors originating from assistant logic (providers, tools,
 * permissions, config). Extends VellumError and carries a structured ErrorCode.
 */
export class AssistantError extends VellumError {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AssistantError";
  }
}

export class ProviderError extends AssistantError {
  /** Delay (in ms) suggested by the server's Retry-After header, if present. */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, ErrorCode.PROVIDER_ERROR, options);
    this.name = "ProviderError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ToolError extends AssistantError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message, ErrorCode.TOOL_ERROR);
    this.name = "ToolError";
  }
}

export class PermissionDeniedError extends AssistantError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message, ErrorCode.PERMISSION_DENIED);
    this.name = "PermissionDeniedError";
  }
}

export class ConfigError extends AssistantError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ErrorCode.CONFIG_ERROR, options);
    this.name = "ConfigError";
  }
}

export class ProviderNotConfiguredError extends ConfigError {
  constructor(
    public readonly requestedProvider: string,
    public readonly registeredProviders: string[],
  ) {
    super(
      `No providers available. Requested: "${requestedProvider}". Registered: ${registeredProviders.join(", ") || "none"}`,
    );
    this.name = "ProviderNotConfiguredError";
  }
}

export class DaemonError extends AssistantError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ErrorCode.DAEMON_ERROR, options);
    this.name = "DaemonError";
  }
}

export class PlatformError extends AssistantError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ErrorCode.PLATFORM_ERROR, options);
    this.name = "PlatformError";
  }
}

export class IntegrityError extends AssistantError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ErrorCode.INTEGRITY_ERROR, options);
    this.name = "IntegrityError";
  }
}

export class IngressBlockedError extends AssistantError {
  constructor(
    message: string,
    public readonly detectedTypes: string[],
  ) {
    super(message, ErrorCode.INGRESS_BLOCKED);
    this.name = "IngressBlockedError";
  }
}
