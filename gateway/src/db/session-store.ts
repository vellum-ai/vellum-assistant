/**
 * Gateway-owned channel verification session store.
 *
 * Drizzle-backed port of the assistant's channel-verification-sessions
 * store (Combo 13: verification sessions become gateway-native). Same
 * semantics and status vocabulary; `consumeSession` is status-guarded so
 * only the first concurrent consumer wins.
 */

import type { Database } from "bun:sqlite";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  type SQL,
} from "drizzle-orm";

import type {
  IdentityBindingStatus,
  SessionStatus,
  VerificationPurpose,
  VerificationSessionWire,
} from "@vellumai/gateway-client";

import { getGatewayDb } from "./connection.js";
import { channelVerificationSessions } from "./schema.js";

// ---------------------------------------------------------------------------
// Types (single-sourced from the shared contract)
// ---------------------------------------------------------------------------

export type {
  IdentityBindingStatus,
  SessionStatus,
  VerificationPurpose,
} from "@vellumai/gateway-client";

/** Session row as the store returns it — identical to the wire DTO. */
export type VerificationSession = VerificationSessionWire;

/**
 * Statuses that represent an interceptable (consumable) session:
 * 'pending' (inbound), 'pending_bootstrap' / 'awaiting_response' (outbound).
 */
const INTERCEPTABLE_STATUSES: SessionStatus[] = [
  "pending",
  "pending_bootstrap",
  "awaiting_response",
];

/**
 * Outbound statuses a fresh outbound session for the same actor supersedes.
 *
 * Deliberately excludes `pending`: that is an inbound challenge, superseded by
 * `createInboundSession` and no business of an outbound mint.
 */
const OUTBOUND_LIVE_STATUSES: SessionStatus[] = [
  "pending_bootstrap",
  "awaiting_response",
];

/**
 * Narrows a session lookup to the one the caller means.
 *
 * Both axes exist because a channel can carry several live sessions at once:
 * one per person verifying, plus the guardian's own flow.
 */
export interface SessionFilter {
  expectedExternalUserId?: string;
  verificationPurpose?: VerificationPurpose;
}

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
 * Scoped to 'pending' status only — this is the inbound verification path used by
 * the call setup router to gate incoming voice calls. Outbound session states
 * (pending_bootstrap, awaiting_response) are excluded so that an active outbound
 * verification does not inadvertently force unrelated inbound callers into the
 * verification flow.
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

/**
 * Latest non-expired session for a channel in one of the given statuses.
 *
 * Several people can be verifying on a channel at once, and a guardian's own
 * flow runs alongside theirs, so a caller that means "the session I am working
 * on" has to say which. Unfiltered, it gets whoever started most recently.
 */
export function findLatestSessionByStatuses(
  channel: string,
  statuses: SessionStatus[],
  filter: SessionFilter = {},
): VerificationSession | null {
  const db = getGatewayDb();

  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        inArray(channelVerificationSessions.status, statuses),
        gt(channelVerificationSessions.expiresAt, Date.now()),
        ...(filter.expectedExternalUserId
          ? [
              eq(
                channelVerificationSessions.expectedExternalUserId,
                filter.expectedExternalUserId,
              ),
            ]
          : []),
        ...(filter.verificationPurpose
          ? [
              eq(
                channelVerificationSessions.verificationPurpose,
                filter.verificationPurpose,
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(channelVerificationSessions.createdAt))
    .get();

  return row ? rowToSession(row) : null;
}

/**
 * True if the channel has any non-expired interceptable session
 * (pending, pending_bootstrap, or awaiting_response).
 */
export function hasInterceptableSession(channel: string): boolean {
  const db = getGatewayDb();
  const row = db
    .select({ id: channelVerificationSessions.id })
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        inArray(channelVerificationSessions.status, INTERCEPTABLE_STATUSES),
        gt(channelVerificationSessions.expiresAt, Date.now()),
      ),
    )
    .get();

  return row !== undefined;
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

/**
 * Claim a `pending_bootstrap` session for the mint that redeemed its deep
 * link, revoking it so the token cannot be spent twice. Status-guarded like
 * {@link consumeSession}: only the first claimant wins, and a later attempt
 * on an already-claimed row reports `false` instead of quietly succeeding.
 *
 * The claim has to name the row rather than match it by identity. A bootstrap
 * row carries whichever identity was bound onto it last, so two people
 * redeeming the same link leave it bound to the second one, and an
 * identity-matched revoke would miss it for the first.
 */
export function claimBootstrapSession(id: string, channel: string): boolean {
  const raw = (getGatewayDb() as unknown as { $client: Database }).$client;
  return (
    raw
      .prepare(
        `UPDATE channel_verification_sessions
       SET status = 'revoked',
           updated_at = ?
       WHERE id = ?
         AND channel = ?
         AND status = 'pending_bootstrap'`,
      )
      .run(Date.now(), id, channel).changes > 0
  );
}

// ---------------------------------------------------------------------------
// Outbound verification sessions (identity-bound)
// ---------------------------------------------------------------------------

/**
 * Match rows bound to the same identity a new mint is bound to.
 *
 * The key is whichever field `checkIdentityMatch` actually redeems on, in its
 * precedence order, and the match requires the stored row to be keyed the same
 * way. A row carrying both a chat id and a user id redeems only on the user id
 * (`identity-match.ts` treats a shared chat id as insufficient), so it is not
 * matched by a chat-keyed mint: two people in one group chat keep their own
 * codes.
 *
 * Returns null when the mint carries no identity at all, which is a bootstrap
 * session; those are claimed by `claimBootstrapSession` instead.
 */
function sameBoundIdentity(params: {
  expectedExternalUserId?: string | null;
  expectedChatId?: string | null;
  expectedPhoneE164?: string | null;
}): SQL | undefined {
  if (params.expectedExternalUserId) {
    return eq(
      channelVerificationSessions.expectedExternalUserId,
      params.expectedExternalUserId,
    );
  }
  if (params.expectedPhoneE164) {
    return and(
      eq(
        channelVerificationSessions.expectedPhoneE164,
        params.expectedPhoneE164,
      ),
      isNull(channelVerificationSessions.expectedExternalUserId),
    );
  }
  if (params.expectedChatId) {
    return and(
      eq(channelVerificationSessions.expectedChatId, params.expectedChatId),
      isNull(channelVerificationSessions.expectedExternalUserId),
      isNull(channelVerificationSessions.expectedPhoneE164),
    );
  }
  return undefined;
}

/**
 * Create an outbound verification session with expected-identity binding.
 *
 * Supersedes the actor's own prior outbound sessions, so only their latest
 * code is live and an intercepted earlier one is useless.
 *
 * The supersede is scoped to the actor rather than the channel, because that
 * is the scope the replay window has. Two people's codes have no replay
 * relationship: `checkIdentityMatch` binds each to its own expected identity,
 * so A's code cannot be spent against B's session. A channel-wide revoke would
 * take a stranger's live code away for no security benefit, and on a channel
 * where several people can verify at once that is ordinary traffic rather than
 * an edge case.
 *
 * Which field carries that identity is per-channel, so the scope is keyed on
 * whichever one the consume path redeems on (`sameBoundIdentity`). Telegram
 * guardian mints carry only a chat id, and keying on the user id alone would
 * leave every earlier code on that chat live for its full TTL.
 *
 * Inbound (`pending`) sessions are left alone. They have their own supersede
 * in `createInboundSession`, and an outbound mint has nothing to say about an
 * inbound challenge.
 *
 * A session with no expected identity supersedes nothing by actor: a bootstrap
 * session has no actor until its deep link is redeemed. Those are claimed by
 * `claimBootstrapSession` before the mint, not superseded by identity here.
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

  const sameActor = sameBoundIdentity(params);
  if (sameActor) {
    db.update(channelVerificationSessions)
      .set({ status: "revoked", updatedAt: now })
      .where(
        and(
          eq(channelVerificationSessions.channel, params.channel),
          inArray(channelVerificationSessions.status, OUTBOUND_LIVE_STATUSES),
          sameActor,
        ),
      )
      .run();
  }

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
 *
 * Pass a filter when the caller means a particular session: an actor for one
 * person's, a purpose to tell a guardian's own flow apart from a requester's.
 * Unfiltered this returns whoever started most recently, which is right for a
 * caller asking "is anything in flight here" and wrong for one about to
 * resend, cancel, or report state back.
 */
export function findActiveSession(
  channel: string,
  filter: SessionFilter = {},
): VerificationSession | null {
  return findLatestSessionByStatuses(channel, OUTBOUND_LIVE_STATUSES, filter);
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
