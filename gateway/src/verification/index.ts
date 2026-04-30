/**
 * Gateway-owned verification infrastructure.
 *
 * Provides all building blocks for text-channel verification:
 * code parsing, session management, rate limiting, identity matching,
 * contact upsert, binding management, and reply delivery.
 *
 * The main intercept function (tryTextVerificationIntercept) is built
 * in a separate PR on top of these helpers.
 */

export { parseVerificationCode, hashVerificationSecret } from "./code-parsing.js";
export { canonicalizeInboundIdentity } from "./identity.js";
export { checkIdentityMatch } from "./identity-match.js";
export {
  type VerificationSession,
  hasPendingOrActiveSession,
  findSessionByHash,
  consumeSession,
} from "./session-helpers.js";
export {
  getRateLimit,
  isRateLimited,
  recordInvalidAttempt,
  resetRateLimit,
} from "./rate-limit-helpers.js";
export {
  findContactChannelByExternalUserId,
  upsertVerifiedContactChannel,
} from "./contact-helpers.js";
export {
  getExistingGuardianBinding,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";
export {
  composeVerificationSuccessReply,
  composeVerificationFailureReply,
  deliverVerificationReply,
} from "./reply-delivery.js";
