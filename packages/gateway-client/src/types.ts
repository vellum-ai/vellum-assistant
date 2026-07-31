/**
 * @vellumai/gateway-client — shared types
 *
 * Type definitions for assistant-to-gateway communication. These are
 * intentionally decoupled from the assistant's internal types so the
 * package can be consumed without importing assistant internals.
 *
 * HTTP delivery types (ChannelReplyPayload, ApprovalUIMetadata, etc.)
 * are defined as Zod schemas in `outbound-contract.ts` and re-exported
 * from the barrel `index.ts`. This file retains only IPC and utility
 * types that don't cross an HTTP wire boundary.
 */

// Re-export outbound delivery types for backward compatibility — consumers
// that import from "./types.js" continue to work.
export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  AttachmentMetadata,
  ChannelDeliveryResult,
  ChannelReplyPayload,
  PermissionRequestDetails,
} from "./outbound-contract.js";

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

/** NDJSON IPC request envelope. */
export interface IpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** NDJSON IPC response envelope. */
export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: string;
  /** HTTP-style status code mirrored from `RouteError.statusCode`. */
  statusCode?: number;
  /** Machine-readable error code (e.g. "UNPROCESSABLE_ENTITY"). */
  errorCode?: string;
  /**
   * Structured error payload mirroring `RouteError.details` — present only
   * when the originating error carried a `details` field. Mirrors the HTTP
   * adapter's `error.details` envelope so IPC clients can recover the same
   * machine-readable context as HTTP clients.
   */
  errorDetails?: unknown;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal logger contract so consumers can inject their own logger
 * (e.g. pino) without this package depending on a specific logger.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** No-op logger used when no logger is provided. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
