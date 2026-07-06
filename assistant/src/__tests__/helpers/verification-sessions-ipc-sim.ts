/**
 * Test-only in-memory simulator for the gateway's `verification_sessions_*`
 * IPC surface.
 *
 * The gateway owns the session table; integration tests here have no live
 * gateway, so this sim reimplements the gateway store/service semantics
 * (status guards, revoke-prior-on-create, single consume, sliding-window
 * rate limits) over a Map. Wire in an `ipcCallPersistent` mock:
 *
 *   if (isVerificationSessionsIpcMethod(method)) {
 *     return handleVerificationSessionsIpc(method, params);
 *   }
 *
 * Tests may also call the exported lifecycle functions directly to seed or
 * inspect sessions. Call `resetVerificationSessionsSim()` between tests.
 *
 * NOT simulated: the gateway's in-engine role side effects (guardian phone
 * binding, trusted-contact channel upsert) — tests asserting those seed the
 * ACL state through their own helpers.
 */

import { randomBytes, randomUUID } from "node:crypto";

import {
  hashVerificationSecret,
  VERIFICATION_SESSIONS_IPC_METHODS,
  type VerificationSessionWire,
} from "@vellumai/gateway-client";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;

/** Statuses a code redemption may intercept (mirrors the gateway store). */
const INTERCEPTABLE_STATUSES = [
  "pending",
  "pending_bootstrap",
  "awaiting_response",
] as const;

const sessions = new Map<string, VerificationSessionWire>();

interface RateLimitEntry {
  attemptTimestamps: number[];
  lockedUntil: number | null;
}

const rateLimits = new Map<string, RateLimitEntry>();

export function resetVerificationSessionsSim(): void {
  sessions.clear();
  rateLimits.clear();
}

function generateNumericSecret(digits: number = 6): string {
  const num = randomBytes(4).readUInt32BE(0);
  return String(num % 10 ** digits).padStart(digits, "0");
}

function isInterceptable(s: VerificationSessionWire): boolean {
  return (INTERCEPTABLE_STATUSES as readonly string[]).includes(s.status);
}

function revokeInterceptable(channel: string): void {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.channel === channel && isInterceptable(s)) {
      s.status = "revoked";
      s.updatedAt = now;
    }
  }
}

function newestFirst(
  a: VerificationSessionWire,
  b: VerificationSessionWire,
): number {
  return b.createdAt - a.createdAt;
}

// ---------------------------------------------------------------------------
// Session lifecycle (gateway-store semantics)
// ---------------------------------------------------------------------------

export interface SimCreateInboundResult {
  session: VerificationSessionWire;
  secret: string;
  verifyCommand: string;
  ttlSeconds: number;
}

export function createInboundVerificationSession(
  channel: string,
  sourceConversationId?: string,
): SimCreateInboundResult {
  // Revoke-prior mirrors the gateway store: only the latest inbound code is
  // redeemable (store scope is `pending` for inbound creates).
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.channel === channel && s.status === "pending") {
      s.status = "revoked";
      s.updatedAt = now;
    }
  }

  const secret = randomBytes(32).toString("hex");
  const session: VerificationSessionWire = {
    id: randomUUID(),
    channel,
    challengeHash: hashVerificationSecret(secret),
    expiresAt: now + CHALLENGE_TTL_MS,
    status: "pending",
    sourceConversationId: sourceConversationId ?? null,
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
  sessions.set(session.id, session);

  return {
    session,
    secret,
    verifyCommand: secret,
    ttlSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

export interface SimCreateOutboundParams {
  channel: string;
  expectedExternalUserId?: string;
  expectedChatId?: string;
  expectedPhoneE164?: string;
  identityBindingStatus?: "pending_bootstrap" | "bound";
  destinationAddress?: string;
  codeDigits?: number;
  maxAttempts?: number;
  verificationPurpose?: "guardian" | "trusted_contact";
  bootstrapTokenHash?: string;
  sessionId?: string;
}

export interface SimCreateOutboundResult {
  sessionId: string;
  secret: string;
  challengeHash: string;
  expiresAt: number;
  ttlSeconds: number;
}

export function createOutboundSession(
  params: SimCreateOutboundParams,
): SimCreateOutboundResult {
  revokeInterceptable(params.channel);

  const isUnbound = params.identityBindingStatus === "pending_bootstrap";
  const secret = isUnbound
    ? randomBytes(32).toString("hex")
    : generateNumericSecret(params.codeDigits ?? 6);
  const challengeHash = hashVerificationSecret(secret);
  const sessionId = params.sessionId ?? randomUUID();
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_MS;

  sessions.set(sessionId, {
    id: sessionId,
    channel: params.channel,
    challengeHash,
    expiresAt,
    status: isUnbound ? "pending_bootstrap" : "awaiting_response",
    sourceConversationId: null,
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
  });

  return {
    sessionId,
    secret,
    challengeHash,
    expiresAt,
    ttlSeconds: CHALLENGE_TTL_MS / 1000,
  };
}

export type SimGuardedCreateOutboundResult =
  | SimCreateOutboundResult
  | {
      conflict: true;
      reason: "source_session_not_pending" | "active_session_exists";
    };

/** Guarded create (mirrors the gateway's createOutboundSessionGuarded). */
export function createOutboundSessionGuarded(
  params: SimCreateOutboundParams & {
    requireSourceSessionPending?: string;
    ifNoneActive?: boolean;
    ifNoneActiveForExternalUserId?: string;
  },
): SimGuardedCreateOutboundResult {
  const {
    requireSourceSessionPending,
    ifNoneActive,
    ifNoneActiveForExternalUserId,
    ...createParams
  } = params;

  if (requireSourceSessionPending !== undefined) {
    const source = sessions.get(requireSourceSessionPending);
    if (
      !source ||
      source.channel !== params.channel ||
      source.status !== "pending_bootstrap"
    ) {
      return { conflict: true, reason: "source_session_not_pending" };
    }
  }

  if (ifNoneActive && findActiveSession(params.channel) !== null) {
    return { conflict: true, reason: "active_session_exists" };
  }

  if (ifNoneActiveForExternalUserId !== undefined) {
    const active = findActiveSession(params.channel);
    if (
      active !== null &&
      active.expectedExternalUserId === ifNoneActiveForExternalUserId
    ) {
      return { conflict: true, reason: "active_session_exists" };
    }
  }

  return createOutboundSession(createParams);
}

export function getSessionById(id: string): VerificationSessionWire | null {
  return sessions.get(id) ?? null;
}

/** Seed a session row directly (arbitrary status/expiry; no revoke-prior). */
export function seedVerificationSession(
  row: Partial<VerificationSessionWire> &
    Pick<VerificationSessionWire, "id" | "channel" | "challengeHash">,
): VerificationSessionWire {
  const now = Date.now();
  const session: VerificationSessionWire = {
    expiresAt: now + CHALLENGE_TTL_MS,
    status: "pending",
    sourceConversationId: null,
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
    ...row,
  };
  sessions.set(session.id, session);
  return session;
}

export function getPendingSession(
  channel: string,
): VerificationSessionWire | null {
  const now = Date.now();
  return (
    [...sessions.values()].find(
      (s) =>
        s.channel === channel && s.status === "pending" && s.expiresAt > now,
    ) ?? null
  );
}

export function findActiveSession(
  channel: string,
): VerificationSessionWire | null {
  const now = Date.now();
  return (
    [...sessions.values()]
      .filter(
        (s) =>
          s.channel === channel &&
          (s.status === "pending_bootstrap" ||
            s.status === "awaiting_response") &&
          s.expiresAt > now,
      )
      .sort(newestFirst)[0] ?? null
  );
}

export function findSessionByIdentity(
  channel: string,
  externalUserId?: string,
  chatId?: string,
  phoneE164?: string,
): VerificationSessionWire | null {
  if (!externalUserId && !chatId && !phoneE164) {
    return null;
  }
  const now = Date.now();
  return (
    [...sessions.values()]
      .filter(
        (s) =>
          s.channel === channel &&
          (s.status === "pending_bootstrap" ||
            s.status === "awaiting_response") &&
          s.expiresAt > now &&
          ((externalUserId != null &&
            s.expectedExternalUserId === externalUserId) ||
            (chatId != null && s.expectedChatId === chatId) ||
            (phoneE164 != null && s.expectedPhoneE164 === phoneE164)),
      )
      .sort(newestFirst)[0] ?? null
  );
}

/** Takes the RAW token — hashing happens engine-side, as at the gateway. */
export function resolveBootstrapToken(
  channel: string,
  token: string,
): VerificationSessionWire | null {
  const tokenHash = hashVerificationSecret(token);
  const now = Date.now();
  return (
    [...sessions.values()].find(
      (s) =>
        s.channel === channel &&
        s.bootstrapTokenHash === tokenHash &&
        s.status === "pending_bootstrap" &&
        s.expiresAt > now,
    ) ?? null
  );
}

export function bindSessionIdentity(
  id: string,
  externalUserId: string,
  chatId: string,
): void {
  const s = sessions.get(id);
  if (!s) {
    return;
  }
  s.expectedExternalUserId = externalUserId;
  s.expectedChatId = chatId;
  s.identityBindingStatus = "bound";
  s.updatedAt = Date.now();
}

export function updateSessionStatus(
  id: string,
  status: VerificationSessionWire["status"],
  extraFields?: Partial<{
    consumedByExternalUserId: string;
    consumedByChatId: string;
  }>,
): void {
  const s = sessions.get(id);
  if (!s) {
    return;
  }
  s.status = status;
  if (extraFields?.consumedByExternalUserId !== undefined) {
    s.consumedByExternalUserId = extraFields.consumedByExternalUserId;
  }
  if (extraFields?.consumedByChatId !== undefined) {
    s.consumedByChatId = extraFields.consumedByChatId;
  }
  s.updatedAt = Date.now();
}

export function updateSessionDelivery(
  id: string,
  lastSentAt: number,
  sendCount: number,
  nextResendAt: number | null,
): void {
  const s = sessions.get(id);
  if (!s) {
    return;
  }
  s.lastSentAt = lastSentAt;
  s.sendCount = sendCount;
  s.nextResendAt = nextResendAt;
  s.updatedAt = Date.now();
}

export function countRecentSendsToDestination(
  channel: string,
  destinationAddress: string,
  windowMs: number,
): number {
  const cutoff = Date.now() - windowMs;
  return [...sessions.values()].filter(
    (s) =>
      s.channel === channel &&
      s.destinationAddress === destinationAddress &&
      s.lastSentAt != null &&
      s.lastSentAt >= cutoff,
  ).length;
}

export function revokePendingSessions(channel: string): void {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.channel === channel && s.status === "pending") {
      s.status = "revoked";
      s.updatedAt = now;
    }
  }
}

// ---------------------------------------------------------------------------
// Validate + consume (rate limits, identity binding, single consume)
// ---------------------------------------------------------------------------

export type SimValidateConsumeResult =
  | { success: true; verificationType: "guardian" | "trusted_contact" }
  | { success: false; reason: string };

const CONSUME_FAILURE: SimValidateConsumeResult = {
  success: false,
  reason: "invalid_or_expired",
};

function rateLimitKey(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): string {
  return `${channel}\u0000${actorExternalUserId}\u0000${actorChatId}`;
}

/** Test-only rate-limit inspection (mirrors the old getRateLimit read). */
export function getRateLimitState(
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): { invalidAttempts: number; lockedUntil: number | null } | null {
  const entry = rateLimits.get(
    rateLimitKey(channel, actorExternalUserId, actorChatId),
  );
  if (!entry) {
    return null;
  }
  return {
    invalidAttempts: entry.attemptTimestamps.length,
    lockedUntil: entry.lockedUntil,
  };
}

function recordInvalidAttempt(key: string): void {
  const now = Date.now();
  const entry = rateLimits.get(key) ?? {
    attemptTimestamps: [],
    lockedUntil: null,
  };
  entry.attemptTimestamps = entry.attemptTimestamps.filter(
    (ts) => ts > now - RATE_LIMIT_WINDOW_MS,
  );
  entry.attemptTimestamps.push(now);
  if (entry.attemptTimestamps.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
  }
  rateLimits.set(key, entry);
}

function checkIdentityMatch(
  session: VerificationSessionWire,
  actorExternalUserId: string,
  actorChatId: string,
): boolean {
  const hasExpectedIdentity =
    session.expectedExternalUserId != null ||
    session.expectedChatId != null ||
    session.expectedPhoneE164 != null;
  // pending_bootstrap (and unbound inbound) sessions bypass the check.
  if (!hasExpectedIdentity || session.identityBindingStatus !== "bound") {
    return true;
  }

  if (
    session.expectedPhoneE164 != null &&
    (actorExternalUserId === session.expectedPhoneE164 ||
      actorExternalUserId === session.expectedExternalUserId)
  ) {
    return true;
  }

  // Shared-chatId caveat: when both expected fields are set, require the
  // externalUserId match — chat IDs can be shared.
  if (session.expectedChatId != null) {
    if (session.expectedExternalUserId != null) {
      if (actorExternalUserId === session.expectedExternalUserId) {
        return true;
      }
    } else if (actorChatId === session.expectedChatId) {
      return true;
    }
  }

  if (
    session.expectedPhoneE164 == null &&
    session.expectedChatId == null &&
    session.expectedExternalUserId != null &&
    actorExternalUserId === session.expectedExternalUserId
  ) {
    return true;
  }

  return false;
}

export function validateAndConsumeVerification(
  channel: string,
  secret: string,
  actorExternalUserId: string,
  actorChatId: string,
): SimValidateConsumeResult {
  const key = rateLimitKey(channel, actorExternalUserId, actorChatId);
  const now = Date.now();

  const limit = rateLimits.get(key);
  if (limit?.lockedUntil != null && now < limit.lockedUntil) {
    return CONSUME_FAILURE;
  }

  const challengeHash = hashVerificationSecret(secret);
  const session = [...sessions.values()].find(
    (s) =>
      s.channel === channel &&
      s.challengeHash === challengeHash &&
      isInterceptable(s) &&
      s.expiresAt > now,
  );
  if (!session) {
    recordInvalidAttempt(key);
    return CONSUME_FAILURE;
  }

  if (!checkIdentityMatch(session, actorExternalUserId, actorChatId)) {
    recordInvalidAttempt(key);
    return CONSUME_FAILURE;
  }

  // Status-guarded single consume.
  session.status = "consumed";
  session.consumedByExternalUserId = actorExternalUserId;
  session.consumedByChatId = actorChatId;
  session.updatedAt = now;

  // Reset (not delete) so post-success reads see a zeroed record, matching
  // the old resetRateLimit UPDATE semantics.
  const existing = rateLimits.get(key);
  if (existing) {
    existing.attemptTimestamps = [];
    existing.lockedUntil = null;
  }

  return { success: true, verificationType: session.verificationPurpose };
}

// ---------------------------------------------------------------------------
// IPC dispatch
// ---------------------------------------------------------------------------

const METHOD_SET = new Set<string>(
  Object.values(VERIFICATION_SESSIONS_IPC_METHODS),
);

export function isVerificationSessionsIpcMethod(method: string): boolean {
  return METHOD_SET.has(method);
}

export async function handleVerificationSessionsIpc(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const M = VERIFICATION_SESSIONS_IPC_METHODS;
  const p = params as Record<string, never>;
  switch (method) {
    case M.createInbound:
      return createInboundVerificationSession(
        p.channel,
        p.sourceConversationId,
      );
    case M.createOutbound:
      return createOutboundSessionGuarded(
        params as unknown as Parameters<typeof createOutboundSessionGuarded>[0],
      );
    case M.getPending:
      return getPendingSession(p.channel);
    case M.findActive:
      return findActiveSession(p.channel);
    case M.resolveBootstrap:
      return resolveBootstrapToken(p.channel, p.token);
    case M.bindIdentity:
      bindSessionIdentity(p.sessionId, p.externalUserId, p.chatId);
      return { ok: true };
    case M.updateStatus: {
      const extra: Partial<{
        consumedByExternalUserId: string;
        consumedByChatId: string;
      }> = {};
      if (p.consumedByExternalUserId != null) {
        extra.consumedByExternalUserId = p.consumedByExternalUserId;
      }
      if (p.consumedByChatId != null) {
        extra.consumedByChatId = p.consumedByChatId;
      }
      updateSessionStatus(p.sessionId, p.status, extra);
      return { ok: true };
    }
    case M.updateDelivery:
      updateSessionDelivery(
        p.sessionId,
        p.lastSentAt,
        p.sendCount,
        p.nextResendAt ?? null,
      );
      return { ok: true };
    case M.countRecentSends:
      return {
        count: countRecentSendsToDestination(
          p.channel,
          p.destinationAddress,
          p.windowMs,
        ),
      };
    case M.revokePending:
      revokePendingSessions(p.channel);
      return { ok: true };
    case M.validateConsume:
      return validateAndConsumeVerification(
        p.channel,
        p.secret,
        p.actorExternalUserId,
        p.actorChatId,
      );
    default:
      throw new Error(`sim: unhandled verification_sessions method ${method}`);
  }
}
