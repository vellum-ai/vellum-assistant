/**
 * Gateway-owned channel verification session store.
 *
 * Drizzle-backed port of the assistant's channel-verification-sessions
 * store (Combo 13: verification sessions become gateway-native). Same
 * semantics and status vocabulary; `consumeSession` is status-guarded so
 * only the first concurrent consumer wins.
 */

import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gt, gte, inArray, or } from "drizzle-orm";

import { getGatewayDb } from "./connection.js";
import { channelVerificationSessions } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "pending"
  | "consumed"
  | "pending_bootstrap"
  | "awaiting_response"
  | "verified"
  | "expired"
  | "revoked"
  | "locked";
export type IdentityBindingStatus = "pending_bootstrap" | "bound";
export type VerificationPurpose = "guardian" | "trusted_contact";

export interface VerificationSession {
  id: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  status: SessionStatus;
  sourceConversationId: string | null;
  consumedByExternalUserId: string | null;
  consumedByChatId: string | null;
  // Outbound session: expected-identity binding
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: IdentityBindingStatus | null;
  // Outbound session: delivery tracking
  destinationAddress: string | null;
  lastSentAt: number | null;
  sendCount: number;
  nextResendAt: number | null;
  // Session configuration
  codeDigits: number;
  maxAttempts: number;
  // Distinguishes guardian verification from trusted contact verification
  verificationPurpose: VerificationPurpose;
  // Telegram bootstrap deep-link token hash
  bootstrapTokenHash: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Statuses that represent an interceptable (consumable) session:
 * 'pending' (inbound), 'pending_bootstrap' / 'awaiting_response' (outbound).
 */
const INTERCEPTABLE_STATUSES: SessionStatus[] = [
  "pending",
  "pending_bootstrap",
  "awaiting_response",
];

const INTERCEPTABLE_STATUSES_SQL = INTERCEPTABLE_STATUSES.map(
  (s) => `'${s}'`,
).join(", ");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSession(
  row: typeof channelVerificationSessions.$inferSelect,
): VerificationSession {
  return {
    id: row.id,
    channel: row.channel,
    challengeHash: row.challengeHash,
    expiresAt: row.expiresAt,
    status: row.status as SessionStatus,
    sourceConversationId: row.sourceConversationId,
    consumedByExternalUserId: row.consumedByExternalUserId,
    consumedByChatId: row.consumedByChatId,
    expectedExternalUserId: row.expectedExternalUserId ?? null,
    expectedChatId: row.expectedChatId ?? null,
    expectedPhoneE164: row.expectedPhoneE164 ?? null,
    identityBindingStatus:
      (row.identityBindingStatus as IdentityBindingStatus) ?? null,
    destinationAddress: row.destinationAddress ?? null,
    lastSentAt: row.lastSentAt ?? null,
    sendCount: row.sendCount ?? 0,
    nextResendAt: row.nextResendAt ?? null,
    codeDigits: row.codeDigits ?? 6,
    maxAttempts: row.maxAttempts ?? 3,
    verificationPurpose:
      (row.verificationPurpose as VerificationPurpose) ?? "guardian",
    bootstrapTokenHash: row.bootstrapTokenHash ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Inbound verification sessions
// ---------------------------------------------------------------------------

export function createInboundSession(params: {
  id: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  sourceConversationId?: string;
}): VerificationSession {
  const db = getGatewayDb();
  const now = Date.now();

  // Revoke any prior pending sessions for the same channel
  // to close the replay window — only the latest session should be valid.
  db.update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(channelVerificationSessions.channel, params.channel),
        eq(channelVerificationSessions.status, "pending"),
      ),
    )
    .run();

  const row = {
    id: params.id,
    channel: params.channel,
    challengeHash: params.challengeHash,
    expiresAt: params.expiresAt,
    status: "pending" as const,
    sourceConversationId: params.sourceConversationId ?? null,
    consumedByExternalUserId: null,
    consumedByChatId: null,
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: null,
    destinationAddress: null,
    lastSentAt: null,
    sendCount: 0,
    nextResendAt: null,
    codeDigits: 6,
    maxAttempts: 3,
    verificationPurpose: "guardian" as const,
    bootstrapTokenHash: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelVerificationSessions).values(row).run();

  return rowToSession(row);
}

export function revokePendingSessions(channel: string): void {
  const db = getGatewayDb();
  db.update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.status, "pending"),
      ),
    )
    .run();
}

export function findPendingSessionByHash(
  channel: string,
  challengeHash: string,
): VerificationSession | null {
  const db = getGatewayDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.challengeHash, challengeHash),
        inArray(channelVerificationSessions.status, INTERCEPTABLE_STATUSES),
        gt(channelVerificationSessions.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * Find any pending inbound (non-expired) session for a given channel.
 * Scoped to 'pending' status only — outbound session states
 * (pending_bootstrap, awaiting_response) are excluded so that an active
 * outbound verification does not inadvertently force unrelated inbound
 * callers into the verification flow.
 */
export function findPendingSessionForChannel(
  channel: string,
): VerificationSession | null {
  const db = getGatewayDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.status, "pending"),
        gt(channelVerificationSessions.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToSession(row) : null;
}

export type ConsumeSessionResult =
  | { consumed: true; consumedAt: number }
  | { consumed: false };

/**
 * Mark a session consumed. The status guard ensures atomicity under
 * concurrent consumers — only the first wins; later attempts (or attempts
 * on already-consumed/revoked/expired-status rows) see zero changes and
 * return `{consumed: false}`, preserving one-time-code semantics.
 *
 * On success, `consumedAt` is the exact `updated_at` written by the UPDATE,
 * so callers anchoring recency checks (ATL-514) never re-sample the clock.
 */
export function consumeSession(
  id: string,
  actorExternalUserId: string,
  actorChatId: string,
): ConsumeSessionResult {
  // Raw client because drizzle's bun-sqlite run() does not surface the
  // changes count needed for the single-consumer guarantee.
  const raw = (getGatewayDb() as unknown as { $client: Database }).$client;
  const consumedAt = Date.now();
  const changes = raw
    .prepare(
      `UPDATE channel_verification_sessions
       SET status = 'consumed',
           consumed_by_external_user_id = ?,
           consumed_by_chat_id = ?,
           updated_at = ?
       WHERE id = ?
         AND status IN (${INTERCEPTABLE_STATUSES_SQL})`,
    )
    .run(actorExternalUserId, actorChatId, consumedAt, id).changes;

  return changes > 0 ? { consumed: true, consumedAt } : { consumed: false };
}

// ---------------------------------------------------------------------------
// Outbound verification sessions (identity-bound)
// ---------------------------------------------------------------------------

/**
 * Create an outbound verification session with expected-identity binding.
 * Auto-revokes prior pending/pending_bootstrap/awaiting_response sessions
 * for the same channel to close the replay window.
 */
export function createOutboundSession(params: {
  id: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  status: SessionStatus;
  sourceConversationId?: string;
  expectedExternalUserId?: string | null;
  expectedChatId?: string | null;
  expectedPhoneE164?: string | null;
  identityBindingStatus?: IdentityBindingStatus;
  destinationAddress?: string | null;
  codeDigits?: number;
  maxAttempts?: number;
  verificationPurpose?: VerificationPurpose;
  bootstrapTokenHash?: string | null;
}): VerificationSession {
  const db = getGatewayDb();
  const now = Date.now();

  db.update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(channelVerificationSessions.channel, params.channel),
        inArray(channelVerificationSessions.status, INTERCEPTABLE_STATUSES),
      ),
    )
    .run();

  const row = {
    id: params.id,
    channel: params.channel,
    challengeHash: params.challengeHash,
    expiresAt: params.expiresAt,
    status: params.status as string,
    sourceConversationId: params.sourceConversationId ?? null,
    consumedByExternalUserId: null,
    consumedByChatId: null,
    expectedExternalUserId: params.expectedExternalUserId ?? null,
    expectedChatId: params.expectedChatId ?? null,
    expectedPhoneE164: params.expectedPhoneE164 ?? null,
    identityBindingStatus: params.identityBindingStatus ?? "bound",
    destinationAddress: params.destinationAddress ?? null,
    lastSentAt: null,
    sendCount: 0,
    nextResendAt: null,
    codeDigits: params.codeDigits ?? 6,
    maxAttempts: params.maxAttempts ?? 3,
    verificationPurpose: params.verificationPurpose ?? "guardian",
    bootstrapTokenHash: params.bootstrapTokenHash ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelVerificationSessions).values(row).run();

  return rowToSession(row);
}

/** Look up a session by id regardless of status. */
export function getSessionById(id: string): VerificationSession | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * Find the most recent pending_bootstrap or awaiting_response session
 * for a given channel.
 */
export function findActiveSession(channel: string): VerificationSession | null {
  const db = getGatewayDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        inArray(channelVerificationSessions.status, [
          "pending_bootstrap",
          "awaiting_response",
        ]),
        gt(channelVerificationSessions.expiresAt, now),
      ),
    )
    .orderBy(desc(channelVerificationSessions.createdAt))
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * Look up a pending_bootstrap session by its bootstrap token hash.
 * Used by the Telegram /start gv_<token> bootstrap flow.
 */
export function findSessionByBootstrapTokenHash(
  channel: string,
  tokenHash: string,
): VerificationSession | null {
  const db = getGatewayDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.bootstrapTokenHash, tokenHash),
        eq(channelVerificationSessions.status, "pending_bootstrap"),
        gt(channelVerificationSessions.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * Identity-bound lookup for the consume path. Finds a session matching the
 * given identity fields with an active status.
 */
export function findSessionByIdentity(
  channel: string,
  externalUserId?: string,
  chatId?: string,
  phoneE164?: string,
): VerificationSession | null {
  // Require at least one identity parameter to avoid accidentally matching
  // an unrelated session when the caller has no parsed identity fields.
  if (!externalUserId && !chatId && !phoneE164) {
    return null;
  }

  const db = getGatewayDb();
  const now = Date.now();

  const identityConditions = [];
  if (externalUserId) {
    identityConditions.push(
      eq(channelVerificationSessions.expectedExternalUserId, externalUserId),
    );
  }
  if (chatId) {
    identityConditions.push(
      eq(channelVerificationSessions.expectedChatId, chatId),
    );
  }
  if (phoneE164) {
    identityConditions.push(
      eq(channelVerificationSessions.expectedPhoneE164, phoneE164),
    );
  }

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        inArray(channelVerificationSessions.status, [
          "pending_bootstrap",
          "awaiting_response",
        ]),
        gt(channelVerificationSessions.expiresAt, now),
        or(...identityConditions),
      ),
    )
    .orderBy(desc(channelVerificationSessions.createdAt))
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * Transition a session's status with optional extra field updates.
 */
export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extraFields?: Partial<{
    consumedByExternalUserId: string;
    consumedByChatId: string;
  }>,
): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.update(channelVerificationSessions)
    .set({
      status,
      updatedAt: now,
      ...(extraFields?.consumedByExternalUserId !== undefined
        ? { consumedByExternalUserId: extraFields.consumedByExternalUserId }
        : {}),
      ...(extraFields?.consumedByChatId !== undefined
        ? { consumedByChatId: extraFields.consumedByChatId }
        : {}),
    })
    .where(eq(channelVerificationSessions.id, id))
    .run();
}

/**
 * Update outbound delivery tracking fields on a session.
 */
export function updateSessionDelivery(
  id: string,
  lastSentAt: number,
  sendCount: number,
  nextResendAt: number | null,
): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.update(channelVerificationSessions)
    .set({
      lastSentAt,
      sendCount,
      nextResendAt,
      updatedAt: now,
    })
    .where(eq(channelVerificationSessions.id, id))
    .run();
}

/**
 * Count actual sends to a specific destination across all sessions within a
 * rolling time window. Uses COUNT of rows with a last_sent_at timestamp
 * inside the window rather than SUM(send_count) to avoid double-counting
 * cumulative session counters when resend creates new sessions that carry
 * forward the cumulative count.
 */
export function countRecentSendsToDestination(
  channel: string,
  destinationAddress: string,
  windowMs: number,
): number {
  const db = getGatewayDb();
  const cutoff = Date.now() - windowMs;

  const result = db
    .select({ total: count() })
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.destinationAddress, destinationAddress),
        gte(channelVerificationSessions.lastSentAt, cutoff),
      ),
    )
    .get();

  return result?.total ?? 0;
}

/**
 * Telegram bootstrap completion: bind the expected identity fields and
 * transition identity_binding_status from pending_bootstrap to bound.
 */
export function bindSessionIdentity(
  id: string,
  externalUserId: string,
  chatId: string,
): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.update(channelVerificationSessions)
    .set({
      expectedExternalUserId: externalUserId,
      expectedChatId: chatId,
      identityBindingStatus: "bound",
      updatedAt: now,
    })
    .where(eq(channelVerificationSessions.id, id))
    .run();
}
