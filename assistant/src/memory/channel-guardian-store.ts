/**
 * Re-export hub for channel guardian store modules.
 *
 * The implementation has been split into focused modules:
 * - channel-verification-sessions.ts — verification session management
 * - guardian-approvals.ts             — approval request tracking
 * - guardian-rate-limits.ts           — verification rate limiting
 *
 * Guardian binding types (GuardianBinding, BindingStatus) are defined locally
 * here.
 *
 * This file re-exports everything for backward compatibility.
 */

// ---------------------------------------------------------------------------
// Guardian binding types
// ---------------------------------------------------------------------------

export type BindingStatus = "active" | "revoked";

export interface GuardianBinding {
  id: string;
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  guardianPrincipalId: string;
  status: BindingStatus;
  verifiedAt: number;
  verifiedVia: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Re-exports from focused modules
// ---------------------------------------------------------------------------

export {
  bindSessionIdentity,
  consumeSession,
  countRecentSendsToDestination,
  createInboundSession,
  createVerificationSession,
  findActiveSession,
  findPendingSessionByHash,
  findPendingSessionForChannel,
  findSessionByBootstrapTokenHash,
  findSessionByIdentity,
  type IdentityBindingStatus,
  type InboundSessionStatus,
  revokePendingSessions,
  type SessionStatus,
  updateSessionDelivery,
  updateSessionStatus,
  type VerificationPurpose,
  type VerificationSession,
} from "./channel-verification-sessions.js";
export {
  type ApprovalRequestStatus,
  countPendingByConversation,
  // @internal — test-only helpers; production code uses canonical-guardian-store
  createApprovalRequest,
  findPendingAccessRequestForRequester,
  getAllPendingApprovalsByGuardianChat,
  getApprovalRequestById,
  getExpiredPendingApprovals,
  getPendingApprovalByGuardianChat,
  getPendingApprovalByRequestAndGuardianChat,
  getPendingApprovalForRequest,
  getUnresolvedApprovalForRequest,
  type GuardianApprovalRequest,
  listPendingApprovalRequests,
  resolveApprovalRequest,
  updateApprovalDecision,
} from "./guardian-approvals.js";
export {
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
  type VerificationRateLimit,
} from "./guardian-rate-limits.js";
