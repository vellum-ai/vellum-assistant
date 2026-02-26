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
  type BindingStatus,
  type GuardianBinding,
  createBinding,
  getActiveBinding,
  revokeBinding,
} from './guardian-bindings.js';

export {
  type ChallengeStatus,
  type SessionStatus,
  type IdentityBindingStatus,
  type VerificationChallenge,
  createChallenge,
  revokePendingChallenges,
  findPendingChallengeByHash,
  findPendingChallengeForChannel,
  consumeChallenge,
  createVerificationSession,
  findActiveSession,
  findSessionByBootstrapTokenHash,
  findSessionByIdentity,
  updateSessionStatus,
  updateSessionDelivery,
  countRecentSendsToDestination,
  bindSessionIdentity,
} from './guardian-verification.js';

export {
  type ApprovalRequestStatus,
  type GuardianApprovalRequest,
  createApprovalRequest,
  getPendingApprovalForRun,
  getPendingApprovalForRequest,
  getUnresolvedApprovalForRun,
  getUnresolvedApprovalForRequest,
  getPendingApprovalByGuardianChat,
  getPendingApprovalByRunAndGuardianChat,
  getPendingApprovalByRequestAndGuardianChat,
  getAllPendingApprovalsByGuardianChat,
  getExpiredPendingApprovals,
  updateApprovalDecision,
  listPendingApprovalRequests,
  getApprovalRequestById,
  getApprovalRequestByRunId,
  resolveApprovalRequest,
  countPendingByConversation,
} from './guardian-approvals.js';

export {
  type VerificationRateLimit,
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
} from './guardian-rate-limits.js';
