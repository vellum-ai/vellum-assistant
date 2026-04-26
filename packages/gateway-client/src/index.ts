/**
 * @vellumai/gateway-client
 *
 * Shared client package for assistant-to-gateway communication. Provides
 * HTTP delivery, trust-rule CRUD, and Unix-socket IPC helpers that the
 * assistant daemon uses to interact with the gateway service.
 *
 * This package is intentionally free of imports from `assistant/` or
 * `gateway/` so both sides can depend on it without circular references.
 */

export {
  ChannelDeliveryError,
  deliverApprovalPrompt,
  deliverChannelReply,
} from "./http-delivery.js";

export {
  ipcCall,
  PersistentIpcClient,
} from "./ipc-client.js";

export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  AttachmentMetadata,
  ChannelDeliveryResult,
  ChannelReplyPayload,
  IpcRequest,
  IpcResponse,
  Logger,
  PermissionRequestDetails,
} from "./types.js";

export { noopLogger } from "./types.js";
