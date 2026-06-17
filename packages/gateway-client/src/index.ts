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

export * from "./gateway-ipc-contracts.js";

export { ipcCall, IpcCallError, PersistentIpcClient } from "./ipc-client.js";

// Outbound delivery contract (daemon → gateway) — Zod schemas + derived types
export {
  ApprovalActionOptionSchema,
  ApprovalUIMetadataSchema,
  AttachmentMetadataSchema,
  ChannelDeliveryResultSchema,
  ChannelReplyPayloadSchema,
  PermissionRequestDetailsSchema,
} from "./outbound-contract.js";

export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  AttachmentMetadata,
  ChannelDeliveryResult,
  ChannelReplyPayload,
  PermissionRequestDetails,
} from "./outbound-contract.js";

// Inbound contract (gateway → daemon) — Zod schemas + derived types
export {
  CommandIntentSchema,
  RuntimeInboundPayloadSchema,
  SourceMetadataSchema,
} from "./inbound-contract.js";

export type {
  CommandIntent,
  RuntimeInboundPayload,
  SourceMetadata,
} from "./inbound-contract.js";

// IPC, logger, and utility types
export type { IpcRequest, IpcResponse, Logger } from "./types.js";

export { noopLogger } from "./types.js";

// Admission policy contract (gateway → daemon) — Zod schemas + derived types + exempt channels
export {
  ADMISSION_FLOOR,
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_EXEMPT_CHANNELS,
  ADMISSION_POLICY_VALUES,
  AdmissionPolicySchema,
  isAdmissionPolicy,
  isAdmissionPolicyExemptChannel,
  isKillSwitchForbiddenChannel,
  KILL_SWITCH_FORBIDDEN_CHANNELS,
} from "./admission-policy-contract.js";

export type { AdmissionPolicy } from "./admission-policy-contract.js";
