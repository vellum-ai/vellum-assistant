/**
 * Verification session helpers for gateway-owned verification.
 *
 * Thin delegates over the gateway-native session store — the gateway DB
 * owns session state. The async signatures are preserved from the db_proxy
 * era so callers are unaffected.
 */

import {
  consumeSession as storeConsumeSession,
  findPendingSessionByHash,
  hasInterceptableSession,
} from "../db/session-store.js";
import { getLogger } from "../logger.js";

const log = getLogger("verification-sessions");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationSession {
  id: string;
  challengeHash: string;
  expiresAt: number;
  status: string;
  verificationPurpose: string;
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: string | null;
  codeDigits: number | null;
  maxAttempts: number | null;
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Check whether there is any pending/active verification session for this
 * channel. Used as a fast guard before attempting code parsing + validation.
 */
export async function hasPendingOrActiveSession(
  channel: string,
): Promise<boolean> {
  return hasInterceptableSession(channel);
}

/**
 * Find a session matching a specific challenge hash.
 */
export async function findSessionByHash(
  channel: string,
  challengeHash: string,
): Promise<VerificationSession | null> {
  return findPendingSessionByHash(channel, challengeHash);
}

// ---------------------------------------------------------------------------
// Session consumption
// ---------------------------------------------------------------------------

/**
 * Mark a verification session as consumed. The store's status guard ensures
 * only the first concurrent consumer wins — subsequent attempts return false,
 * preserving one-time-code semantics under race conditions.
 */
export async function consumeSession(
  sessionId: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<boolean> {
  const result = storeConsumeSession(
    sessionId,
    actorExternalUserId,
    actorChatId,
  );

  if (!result.consumed) {
    log.warn(
      { sessionId },
      "Session consume returned 0 changes — already consumed or status changed",
    );
    return false;
  }

  return true;
}
