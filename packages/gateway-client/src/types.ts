/**
 * @vellumai/gateway-client — shared types
 *
 * Type definitions for assistant-to-gateway communication. These are
 * intentionally decoupled from the assistant's internal types so the
 * package can be consumed without importing assistant internals.
 */

// ---------------------------------------------------------------------------
// HTTP delivery types
// ---------------------------------------------------------------------------

/** Metadata for a file attachment delivered alongside a channel reply. */
export interface AttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  data?: string;
  thumbnailData?: string;
  fileBacked?: boolean;
}

/** An action option presented to the user in an approval prompt. */
export interface ApprovalActionOption {
  id: string;
  label: string;
}

/**
 * Tool-permission-specific details carried alongside the approval payload.
 * Channels that support rich UI (e.g. Slack Block Kit) use these fields
 * to render a detailed permission request card.
 */
export interface PermissionRequestDetails {
  toolName: string;
  riskLevel: string;
  toolInput: Record<string, unknown>;
  requesterIdentifier?: string;
}

/**
 * Metadata attached to gateway callback payloads for rendering approval
 * UI and routing decisions back to the correct pending interaction.
 */
export interface ApprovalUIMetadata {
  requestId: string;
  actions: ApprovalActionOption[];
  plainTextFallback: string;
  permissionDetails?: PermissionRequestDetails;
}

/** Payload for a channel reply delivered via the gateway. */
export interface ChannelReplyPayload {
  chatId: string;
  text?: string;
  /** Pre-formatted Block Kit blocks for Slack delivery. */
  blocks?: unknown[];
  assistantId?: string;
  attachments?: AttachmentMetadata[];
  approval?: ApprovalUIMetadata;
  chatAction?: "typing";
  /**
   * When true, deliver via `chat.postEphemeral` so only the target `user`
   * sees the message.
   */
  ephemeral?: boolean;
  /** Slack user ID — required when `ephemeral` is true. */
  user?: string;
  /** When provided, update an existing message instead of posting a new one. */
  messageTs?: string;
  /** When true, auto-generate Block Kit blocks from text via textToBlocks(). */
  useBlocks?: boolean;
  /** When provided, add or remove an emoji reaction on a message. */
  reaction?: { action: "add" | "remove"; name: string; messageTs: string };
  /** When provided, set or clear the Slack Assistants API thread status. */
  assistantThreadStatus?: {
    channel: string;
    threadTs: string;
    status: string;
  };
}

/** Result from a channel delivery attempt. */
export interface ChannelDeliveryResult {
  ok: boolean;
  /** The message timestamp returned by the delivery endpoint. */
  ts?: string;
}

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
