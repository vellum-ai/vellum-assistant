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
  SlackStreamOpSchema,
  SlackStreamTaskSchema,
} from "./outbound-contract.js";

export type {
  ApprovalActionOption,
  ApprovalUIMetadata,
  AttachmentMetadata,
  ChannelDeliveryResult,
  ChannelReplyPayload,
  PermissionRequestDetails,
  SlackStreamOp,
  SlackStreamTask,
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

// Admission policy contract (gateway → daemon) — Zod schemas + derived types + channel sets
export {
  ADMISSION_FLOOR,
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_EXEMPT_CHANNELS,
  ADMISSION_POLICY_HIDDEN_CHANNELS,
  ADMISSION_POLICY_VALUES,
  AdmissionPolicySchema,
  isAdmissionPolicy,
  isAdmissionPolicyExemptChannel,
  isAdmissionPolicyHiddenChannel,
} from "./admission-policy-contract.js";

export type { AdmissionPolicy } from "./admission-policy-contract.js";

// Trust verdict contract (gateway → daemon) — Zod schemas + derived types
export {
  isTrustClass,
  makeResolutionFailedVerdict,
  ResolveInboundTrustRequestSchema,
  TRUST_CLASS_VALUES,
  TrustClassSchema,
  TrustVerdictSchema,
} from "./trust-verdict-contract.js";

export type {
  ResolveInboundTrustRequest,
  TrustClass,
  TrustVerdict,
} from "./trust-verdict-contract.js";

// Invite contract (shared gateway ↔ daemon) — hash/generate helpers,
// channel gating, redemption outcome + invite IPC schemas
export {
  ActiveVoiceInviteSchema,
  generateInviteCode,
  generateInviteToken,
  GetActiveVoiceInviteRequestSchema,
  hashInviteCode,
  hashInviteToken,
  INVITE_CODE_REDEMPTION_CHANNELS,
  INVITE_REDEMPTION_RESULT_VALUES,
  InviteRedeemedNotificationSchema,
  InviteRedemptionOutcomeSchema,
  isInviteCodeRedemptionEnabled,
  isValidE164,
  RedeemInviteByCodeRequestSchema,
  RedeemInviteByTokenRequestSchema,
  RedeemVoiceInviteRequestSchema,
} from "./invite-contract.js";

export type {
  ActiveVoiceInvite,
  GetActiveVoiceInviteRequest,
  InviteRedeemedNotification,
  InviteRedemptionOutcome,
  InviteRedemptionResult,
  RedeemInviteByCodeRequest,
  RedeemInviteByTokenRequest,
  RedeemVoiceInviteRequest,
} from "./invite-contract.js";

// Guardian delivery contract (daemon → gateway pull) — Zod schemas + derived types
export {
  GuardianDeliverySchema,
  ResolveGuardianDeliveryRequestSchema,
  ResolveGuardianDeliveryResponseSchema,
} from "./guardian-delivery-contract.js";

export type {
  GuardianDelivery,
  ResolveGuardianDeliveryRequest,
  ResolveGuardianDeliveryResponse,
} from "./guardian-delivery-contract.js";
