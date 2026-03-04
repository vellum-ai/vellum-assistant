/**
 * Re-export hub for channel guardian store modules.
 *
 * The implementation has been split into focused modules:
 * - guardian-bindings.ts    — channel binding CRUD
 * - guardian-verification.ts — verification challenge/session management
 * - guardian-approvals.ts   — approval request tracking
 * - guardian-rate-limits.ts — verification rate limiting
 *
 * This file re-exports everything for backward compatibility.
 */

export {
  type ApprovalRequestStatus,
  countPendingByConversation,
  // @internal — test-only helpers; production code uses canonical-guardian-store
  createApprovalRequest,
  findPendingAccessRequestForRequester,
  getAllPendingApprovalsByGuardianChat,
  getApprovalRequestById,
  getApprovalRequestByRunId,
  getExpiredPendingApprovals,
  getPendingApprovalByGuardianChat,
  getPendingApprovalByRequestAndGuardianChat,
  getPendingApprovalByRunAndGuardianChat,
  getPendingApprovalForRequest,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRequest,
  getUnresolvedApprovalForRun,
  type GuardianApprovalRequest,
  listPendingApprovalRequests,
  resolveApprovalRequest,
  updateApprovalDecision,
} from "./guardian-approvals.js";
export {
  type BindingStatus,
  createBinding,
  getActiveBinding,
  type GuardianBinding,
  revokeBinding,
} from "./guardian-bindings.js";
export {
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
  type VerificationRateLimit,
} from "./guardian-rate-limits.js";
export {
  bindSessionIdentity,
  type ChallengeStatus,
  consumeChallenge,
  countRecentSendsToDestination,
  createChallenge,
  createVerificationSession,
  findActiveSession,
  findPendingChallengeByHash,
  findPendingChallengeForChannel,
  findSessionByBootstrapTokenHash,
  findSessionByIdentity,
  type IdentityBindingStatus,
  revokePendingChallenges,
  type SessionStatus,
  updateSessionDelivery,
  updateSessionStatus,
  type VerificationChallenge,
  type VerificationPurpose,
} from "./guardian-verification.js";
