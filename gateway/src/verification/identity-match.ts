/**
 * Identity matching for verification sessions.
 *
 * Mirrors the assistant's channel-verification-service.ts identity check.
 * Determines whether the actor submitting a verification code matches the
 * expected identity on an outbound session.
 */

import type { VerificationSession } from "../db/session-store.js";

/** The identity fields the match rules read — callers may pass a full row. */
export type IdentityMatchSession = Pick<
  VerificationSession,
  | "expectedExternalUserId"
  | "expectedChatId"
  | "expectedPhoneE164"
  | "identityBindingStatus"
>;

/**
 * Check whether the actor matches the session's expected identity.
 *
 * Returns true if:
 * - The session has no expected identity (inbound sessions)
 * - The session's identity binding status is not 'bound' (pending_bootstrap)
 * - The actor matches the expected identity
 */
export function checkIdentityMatch(
  session: IdentityMatchSession,
  actorExternalUserId: string,
  actorChatId: string,
): boolean {
  const hasExpectedIdentity =
    session.expectedExternalUserId != null ||
    session.expectedChatId != null ||
    session.expectedPhoneE164 != null;

  if (!hasExpectedIdentity || session.identityBindingStatus !== "bound") {
    return true;
  }

  // Phone match
  if (session.expectedPhoneE164 != null) {
    if (
      actorExternalUserId === session.expectedPhoneE164 ||
      actorExternalUserId === session.expectedExternalUserId
    ) {
      return true;
    }
  }

  // Chat ID match (Telegram, Slack, etc.)
  if (session.expectedChatId != null) {
    if (session.expectedExternalUserId != null) {
      // When both are set, require the externalUserId match — chatId alone
      // is insufficient (shared group chats).
      if (actorExternalUserId === session.expectedExternalUserId) {
        return true;
      }
    } else if (actorChatId === session.expectedChatId) {
      return true;
    }
  }

  // Fallback: only expectedExternalUserId set (no phone, no chat)
  if (
    session.expectedPhoneE164 == null &&
    session.expectedChatId == null &&
    session.expectedExternalUserId != null
  ) {
    if (actorExternalUserId === session.expectedExternalUserId) {
      return true;
    }
  }

  return false;
}
