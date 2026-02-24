/**
 * Central export point for the Vellum error hierarchy.
 *
 * Import from this module to access any named error class:
 *
 *   import { VellumError, BackendUnavailableError, RateLimitError, ... } from '../errors.js';
 *
 * Full hierarchy (defined in util/errors.ts):
 *
 *   VellumError                     — root base
 *   ├─ BackendError                 — infrastructure / external-service failures
 *   │  ├─ BackendUnavailableError   — service not reachable or not configured
 *   │  └─ RateLimitError            — request or token quota exceeded
 *   ├─ UserError                    — user input / policy violations
 *   └─ AssistantError               — assistant-logic errors (carries ErrorCode)
 *      ├─ ProviderError
 *      ├─ ToolError
 *      ├─ PermissionDeniedError
 *      ├─ ConfigError
 *      ├─ DaemonError
 *      ├─ IpcError
 *      ├─ PlatformError
 *      ├─ IntegrityError
 *      └─ IngressBlockedError
 */
export {
  ErrorCode,
  VellumError,
  BackendError,
  BackendUnavailableError,
  RateLimitError,
  UserError,
  AssistantError,
  ProviderError,
  ToolError,
  PermissionDeniedError,
  ConfigError,
  DaemonError,
  IpcError,
  PlatformError,
  IntegrityError,
  IngressBlockedError,
} from './util/errors.js';
