/**
 * Gateway-owned channel verification session store.
 *
 * Drizzle-backed port of the assistant's channel-verification-sessions
 * store (Combo 13: verification sessions become gateway-native). Same
 * semantics and status vocabulary; `consumeSession` is status-guarded so
 * only the first concurrent consumer wins.
 */

import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";

import {
  bindsSameIdentity,
  boundIdentity,
  VerificationPurposeSchema,
} from "@vellumai/gateway-client";
import type {
  IdentityBindingStatus,
  IdentityBoundSession,
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

/**
 * A row whose purpose is outside the contract is not a session to any read:
 * it matches no code, counts toward no presence check, cannot be claimed,
 * and never shadows a valid row as the newest. Applied in the query, before
 * ordering and limiting, so the store never has to decide what such a row
 * grants. Writes that clean up (revoke-prior, supersede) still reach it.
 */
const HAS_KNOWN_PURPOSE = inArray(
  channelVerificationSessions.verificationPurpose,
  VerificationPurposeSchema.options,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every read filters on {@link HAS_KNOWN_PURPOSE}, so a row that fails the
 * parse here reached the store some other way. It is still not a session,
 * because reading it as any particular purpose would be a grant nobody
 * asked for.
 */
function rowToSession(
  row: typeof channelVerificationSessions.$inferSelect,
): VerificationSession | null {
  const purpose = VerificationPurposeSchema.safeParse(row.verificationPurpose);
  if (!purpose.success) {
    return null;
  }
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
    verificationPurpose: purpose.data,
    bootstrapTokenHash: row.bootstrapTokenHash ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Convert a row the store is about to insert. A create writes only what it
 * can read back as a session, so the row is converted first and a failure
 * throws before the insert: the store built the row itself, so an
 * unreadable one is a defect here, not a lookup miss.
 */
function sessionForInsert(
  row: typeof channelVerificationSessions.$inferSelect,
): VerificationSession {
  const session = rowToSession(row);
  if (!session) {
    throw new Error(
      `Verification session ${row.id} was built without a known purpose`,
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// Inbound verification sessions
// ---------------------------------------------------------------------------

/**
 * An inbound challenge is a guardian session by definition, not by default.
 * It is bound to no identity and its only producer is the owner's own
 * verification control plane, which refuses to mint one while a guardian is
 * linked on the channel. Every trusted-contact code is an outbound,
 * identity-bound session.
 */
export function createInboundSession(params: {
  id: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  sourceConversationId?: string;
}): VerificationSession {
  const db = getGatewayDb();
  const now = Date.now();

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
    verificationPurpose: "guardian",
    bootstrapTokenHash: null,
    createdAt: now,
    updatedAt: now,
  };
  const session = sessionForInsert(row);

  // Revoke any prior pending sessions for the same channel
  // to close the replay window: only the latest session should be valid.
  db.update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(channelVerificationSessions.channel, params.channel),
        eq(channelVerificationSessions.status, "pending"),
      ),
    )
    .run();
  db.insert(channelVerificationSessions).values(row).run();

  return session;
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
        HAS_KNOWN_PURPOSE,
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
        HAS_KNOWN_PURPOSE,
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
        HAS_KNOWN_PURPOSE,
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
    // `created_at` is a millisecond stamp, so two sessions minted in the same
    // tick tie on it and SQLite is free to return either. Several people can
    // be verifying at once, so the tie breaks on insert order: rowid rises
    // with every insert, making "latest" mean the row written last rather
    // than whichever the planner reached first.
    //
    // SQLite qualifies rowid monotonicity in two ways, neither of which
    // reaches this ordering. A rowid may be reused after the highest-numbered
    // row is deleted, but reuse only ever hands back the largest value, so a
    // reused row still sorts newest. `VACUUM` may renumber a table whose
    // primary key is not INTEGER, which this one is not, but it renumbers in
    // existing rowid order, so relative order survives.
    .orderBy(desc(channelVerificationSessions.createdAt), desc(sql`rowid`))
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
        HAS_KNOWN_PURPOSE,
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
 * on an already-claimed row gets null instead of quietly succeeding.
 *
 * Returns the claimed session, because the mint that replaces it continues
 * it: in particular it keeps the session's purpose.
 *
 * The claim has to name the row rather than match it by identity. A bootstrap
 * row carries whichever identity was bound onto it last, so two people
 * redeeming the same link leave it bound to the second one, and an
 * identity-matched revoke would miss it for the first.
 *
 * A bootstrap row with no known purpose cannot be claimed at all: the claim
 * finds nothing, the mint conflicts, and the row is left to expire. The
 * replacement would have to carry the claimed purpose, and a link whose
 * purpose is unknown must not become a code of any kind.
 */
export function claimBootstrapSession(
  id: string,
  channel: string,
): VerificationSession | null {
  const [claimed] = getGatewayDb()
    .update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(
      and(
        eq(channelVerificationSessions.id, id),
        eq(channelVerificationSessions.channel, channel),
        eq(channelVerificationSessions.status, "pending_bootstrap"),
        HAS_KNOWN_PURPOSE,
      ),
    )
    .returning()
    .all();
  return claimed ? rowToSession(claimed) : null;
}

// ---------------------------------------------------------------------------
// Outbound verification sessions (identity-bound)
// ---------------------------------------------------------------------------

/**
 * Revoke live outbound sessions bound to the same identity as a new mint, so
 * only the latest code for that identity is redeemable.
 *
 * The candidates are read and then filtered through `boundIdentity`, the same
 * function the consume path redeems on, rather than through a SQL predicate
 * restating its precedence. A predicate would be a second copy of that rule
 * that has to be kept in step by hand, and the two drifting apart is a silent
 * one-time-code bug: a mint that identifies its recipient by a field the
 * predicate does not check revokes nothing, and every earlier code stays
 * spendable for its full TTL.
 *
 * A mint bound to no identity revokes nothing. That is a bootstrap session,
 * claimed by `claimBootstrapSession` instead.
 */
function revokeSameIdentityOutbound(
  channel: string,
  mint: IdentityBoundSession,
  now: number,
): void {
  const identity = boundIdentity(mint);
  if (identity === null) {
    return;
  }

  const db = getGatewayDb();
  const live = db
    .select({
      id: channelVerificationSessions.id,
      expectedExternalUserId:
        channelVerificationSessions.expectedExternalUserId,
      expectedChatId: channelVerificationSessions.expectedChatId,
      expectedPhoneE164: channelVerificationSessions.expectedPhoneE164,
    })
    .from(channelVerificationSessions)
    .where(
      and(
        eq(channelVerificationSessions.channel, channel),
        inArray(channelVerificationSessions.status, OUTBOUND_LIVE_STATUSES),
      ),
    )
    .all();

  const superseded = live
    .filter((row) => bindsSameIdentity(boundIdentity(row), identity))
    .map((row) => row.id);
  if (superseded.length === 0) {
    return;
  }

  db.update(channelVerificationSessions)
    .set({ status: "revoked", updatedAt: now })
    .where(inArray(channelVerificationSessions.id, superseded))
    .run();
}

/**
 * Create an outbound verification session with expected-identity binding.
 *
 * Supersedes prior outbound sessions bound to the same identity
 * (`revokeSameIdentityOutbound`), so only that identity's latest code is live
 * and an intercepted earlier one is useless. The scope is the identity rather
 * than the channel because that is the scope the replay window has: two
 * people's codes have no replay relationship, so a channel-wide revoke would
 * take a stranger's live code away for no security benefit, and on a channel
 * where several people verify at once that is ordinary traffic.
 *
 * Inbound (`pending`) sessions are left alone. They have their own supersede
 * in `createInboundSession`, and an outbound mint has nothing to say about an
 * inbound challenge.
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
  verificationPurpose: VerificationPurpose;
  bootstrapTokenHash?: string | null;
}): VerificationSession {
  const db = getGatewayDb();
  const now = Date.now();

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
    verificationPurpose: params.verificationPurpose,
    bootstrapTokenHash: params.bootstrapTokenHash ?? null,
    createdAt: now,
    updatedAt: now,
  };
  // Converted before the revoke: a create that cannot be read back must not
  // take the identity's live codes away and then mint nothing.
  const session = sessionForInsert(row);

  revokeSameIdentityOutbound(params.channel, params, now);
  db.insert(channelVerificationSessions).values(row).run();

  return session;
}

/** Look up a session by id regardless of status. */
export function getSessionById(id: string): VerificationSession | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(channelVerificationSessions)
    .where(and(eq(channelVerificationSessions.id, id), HAS_KNOWN_PURPOSE))
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
        HAS_KNOWN_PURPOSE,
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
