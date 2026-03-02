/**
 * Inlined error classes used by the DoorDash skill.
 * Subset of assistant/src/util/errors.ts — kept minimal.
 */

export enum ErrorCode {
  PROVIDER_ERROR = "PROVIDER_ERROR",
  CONFIG_ERROR = "CONFIG_ERROR",
  RATE_LIMIT_ERROR = "RATE_LIMIT_ERROR",
}

export class VellumError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VellumError";
  }
}

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

export class BackendError extends VellumError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendError";
  }
}

export class ProviderError extends AssistantError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message, ErrorCode.PROVIDER_ERROR, options);
    this.name = "ProviderError";
  }
}

export class RateLimitError extends BackendError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ConfigError extends AssistantError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ErrorCode.CONFIG_ERROR, options);
    this.name = "ConfigError";
  }
}
