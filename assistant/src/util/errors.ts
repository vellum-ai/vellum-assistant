export enum ErrorCode {
  // Provider errors
  PROVIDER_ERROR = 'PROVIDER_ERROR',

  // Tool errors
  TOOL_ERROR = 'TOOL_ERROR',

  // Permission errors
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // Config errors
  CONFIG_ERROR = 'CONFIG_ERROR',

  // Daemon errors
  DAEMON_ERROR = 'DAEMON_ERROR',

  // IPC/socket errors
  IPC_ERROR = 'IPC_ERROR',

  // Platform-specific errors (clipboard, unsupported OS features)
  PLATFORM_ERROR = 'PLATFORM_ERROR',

  // WASM integrity check failures
  INTEGRITY_ERROR = 'INTEGRITY_ERROR',

  // Rate limit exceeded
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',

  // Internal/unexpected errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class AssistantError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AssistantError';
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
    this.name = 'ProviderError';
  }
}

export class ToolError extends AssistantError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message, ErrorCode.TOOL_ERROR);
    this.name = 'ToolError';
  }
}

export class PermissionDeniedError extends AssistantError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message, ErrorCode.PERMISSION_DENIED);
    this.name = 'PermissionDeniedError';
  }
}

export class ConfigError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.CONFIG_ERROR);
    this.name = 'ConfigError';
  }
}

export class DaemonError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.DAEMON_ERROR);
    this.name = 'DaemonError';
  }
}

export class IpcError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.IPC_ERROR);
    this.name = 'IpcError';
  }
}

export class PlatformError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.PLATFORM_ERROR);
    this.name = 'PlatformError';
  }
}

export class IntegrityError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.INTEGRITY_ERROR);
    this.name = 'IntegrityError';
  }
}

export class RateLimitError extends AssistantError {
  constructor(message: string) {
    super(message, ErrorCode.RATE_LIMIT_ERROR);
    this.name = 'RateLimitError';
  }
}
