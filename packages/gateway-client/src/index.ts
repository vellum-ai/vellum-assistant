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
  makeUnauthenticatedSenderVerdict,
  ResolveInboundTrustRequestSchema,
  ResolveInboundTrustResponseSchema,
  TRUST_CLASS_VALUES,
  TrustClassSchema,
  TrustVerdictSchema,
} from "./trust-verdict-contract.js";

export type {
  ResolveInboundTrustRequest,
  ResolveInboundTrustResponse,
  TrustClass,
  TrustVerdict,
} from "./trust-verdict-contract.js";

// Invite contract (shared gateway ↔ daemon) — hash/generate helpers,
// channel gating, redemption outcome, method map + invite IPC schemas
export {
  ActiveVoiceInviteSchema,
  CreateInviteIpcResponseSchema,
  generateInviteCode,
  generateInviteToken,
  GetActiveVoiceInviteIpcResponseSchema,
  GetActiveVoiceInviteRequestSchema,
  hashInviteCode,
  hashInviteToken,
  INVITES_IPC_METHODS,
  InviteRedemptionOutcomeSchema,
  InviteRedemptionResultSchema,
  InviteWireSchema,
  isInviteCodeRedemptionEnabled,
  isValidE164,
  ListInvitesIpcResponseSchema,
  RedeemInviteByTokenRequestSchema,
  RedeemInviteTokenIpcResponseSchema,
  RedeemInviteVoiceIpcResponseSchema,
  RedeemVoiceInviteIpcResponseSchema,
  RedeemVoiceInviteRequestSchema,
  RevokeInviteIpcResponseSchema,
} from "./invite-contract.js";

export type {
  ActiveVoiceInvite,
  CreateInviteIpcResponse,
  GetActiveVoiceInviteIpcResponse,
  GetActiveVoiceInviteRequest,
  InviteRedemptionOutcome,
  InviteRedemptionResult,
  InvitesIpcMethod,
  InviteWire,
  ListInvitesIpcResponse,
  RedeemInviteByCodeRequest,
  RedeemInviteByTokenRequest,
  RedeemInviteTokenIpcResponse,
  RedeemInviteVoiceIpcResponse,
  RedeemVoiceInviteIpcResponse,
  RedeemVoiceInviteRequest,
  RevokeInviteIpcResponse,
} from "./invite-contract.js";

// Verification-session contract (shared gateway ↔ daemon) — hash helper,
// status enums, wire DTO + verification_sessions_* IPC schemas
export {
  BindSessionIdentityIpcParamsSchema,
  CHALLENGE_TTL_MS,
  CountRecentSendsIpcParamsSchema,
  CountRecentSendsIpcResponseSchema,
  CreateInboundSessionIpcParamsSchema,
  CreateInboundSessionIpcResponseSchema,
  CreateOutboundSessionConditionalIpcResponseSchema,
  CreateOutboundSessionConflictSchema,
  CreateOutboundSessionIpcParamsSchema,
  CreateOutboundSessionIpcResponseSchema,
  FindActiveSessionIpcParamsSchema,
  GetPendingSessionIpcParamsSchema,
  hashVerificationSecret,
  IdentityBindingStatusSchema,
  ResolveBootstrapSessionIpcParamsSchema,
  RevokePendingSessionsIpcParamsSchema,
  SessionLookupIpcResponseSchema,
  SessionMutationIpcResponseSchema,
  SessionStatusSchema,
  UpdateSessionDeliveryIpcParamsSchema,
  UpdateSessionStatusIpcParamsSchema,
  ValidateConsumeSessionIpcParamsSchema,
  ValidateConsumeSessionIpcResponseSchema,
  VERIFICATION_SESSIONS_IPC_METHODS,
  VerificationPurposeSchema,
  VerificationSessionSchema,
} from "./verification-session-contract.js";

export type {
  BindSessionIdentityIpcParams,
  CountRecentSendsIpcParams,
  CountRecentSendsIpcResponse,
  CreateInboundSessionIpcParams,
  CreateInboundSessionIpcResponse,
  CreateOutboundSessionConditionalIpcResponse,
  CreateOutboundSessionConflict,
  CreateOutboundSessionIpcParams,
  CreateOutboundSessionIpcResponse,
  FindActiveSessionIpcParams,
  GetPendingSessionIpcParams,
  IdentityBindingStatus,
  ResolveBootstrapSessionIpcParams,
  RevokePendingSessionsIpcParams,
  SessionLookupIpcResponse,
  SessionMutationIpcResponse,
  SessionStatus,
  UpdateSessionDeliveryIpcParams,
  UpdateSessionStatusIpcParams,
  ValidateConsumeSessionIpcParams,
  ValidateConsumeSessionIpcResponse,
  VerificationPurpose,
  VerificationSessionsIpcMethod,
  VerificationSessionWire,
} from "./verification-session-contract.js";

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

// Channel permission matrix contract (gateway ↔ daemon ↔ web) — cascade
// cells storing a RiskThreshold per (channel × contact-type)
export {
  CHANNEL_CONVERSATION_TYPES,
  CHANNEL_PERMISSION_SCOPE_RANK,
  CHANNEL_PERMISSION_SCOPES,
  ChannelConversationTypeSchema,
  ChannelPermissionCellKeySchema,
  ChannelPermissionCellSchema,
  ChannelPermissionScopeSchema,
  ChannelPermissionSelectorSchema,
  isChannelConversationType,
  isRiskThreshold,
  ResolveChannelPermissionRequestSchema,
  RISK_THRESHOLD_VALUES,
  RiskThresholdSchema,
} from "./channel-permission-contract.js";

export type {
  ChannelConversationType,
  ChannelPermissionCell,
  ChannelPermissionCellKey,
  ChannelPermissionCellRow,
  ChannelPermissionScope,
  ChannelPermissionSelector,
  ResolveChannelPermissionRequest,
  ResolvedChannelPermission,
  RiskThreshold,
} from "./channel-permission-contract.js";
