import { and, desc, eq, notInArray, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb, rawChanges, rawGet, rawRun } from "../memory/db.js";
import {
  callEvents,
  callPendingQuestions,
  callSessions,
} from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import { cast, createRowMapper } from "../util/row-mapper.js";
import { syncActiveCallLeaseFromSession } from "./active-call-lease.js";
import { validateTransition } from "./call-state-machine.js";
import type {
  CallEvent,
  CallEventType,
  CallPendingQuestion,
  CallSession,
  CallStatus,
} from "./types.js";

const log = getLogger("call-store");

// ── Helpers ──────────────────────────────────────────────────────────

const parseCallSession = createRowMapper<
  typeof callSessions.$inferSelect,
  CallSession
>({
  id: "id",
  conversationId: "conversationId",
  provider: "provider",
  providerCallSid: "providerCallSid",
  fromNumber: "fromNumber",
  toNumber: "toNumber",
  task: "task",
  status: { from: "status", transform: cast<CallSession["status"]>() },
  callMode: { from: "callMode", transform: cast<CallSession["callMode"]>() },
  verificationSessionId: "verificationSessionId",
  inviteFriendName: "inviteFriendName",
  inviteGuardianName: "inviteGuardianName",
  callerIdentityMode: "callerIdentityMode",
  callerIdentitySource: "callerIdentitySource",
  initiatedFromConversationId: "initiatedFromConversationId",
  startedAt: "startedAt",
  endedAt: "endedAt",
  lastError: "lastError",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

const parseCallEvent = createRowMapper<
  typeof callEvents.$inferSelect,
  CallEvent
>({
  id: "id",
  callSessionId: "callSessionId",
  eventType: { from: "eventType", transform: cast<CallEvent["eventType"]>() },
  payloadJson: "payloadJson",
  createdAt: "createdAt",
});

const parsePendingQuestion = createRowMapper<
  typeof callPendingQuestions.$inferSelect,
  CallPendingQuestion
>({
  id: "id",
  callSessionId: "callSessionId",
  questionText: "questionText",
  status: { from: "status", transform: cast<CallPendingQuestion["status"]>() },
  askedAt: "askedAt",
  answeredAt: "answeredAt",
  answerText: "answerText",
});

// ── Call Sessions ────────────────────────────────────────────────────

export function createCallSession(opts: {
  conversationId: string;
  provider: string;
  fromNumber: string;
  toNumber: string;
  task?: string;
  callMode?: string;
  verificationSessionId?: string;
  inviteFriendName?: string;
  inviteGuardianName?: string;
  callerIdentityMode?: string;
  callerIdentitySource?: string;
  initiatedFromConversationId?: string;
}): CallSession {
  const db = getDb();
  const now = Date.now();
  const session = {
    id: uuid(),
    conversationId: opts.conversationId,
    provider: opts.provider,
    providerCallSid: null,
    fromNumber: opts.fromNumber,
    toNumber: opts.toNumber,
    task: opts.task ?? null,
    status: "initiated" as const,
    callMode: (opts.callMode ?? null) as CallSession["callMode"],
    verificationSessionId: opts.verificationSessionId ?? null,
    inviteFriendName: opts.inviteFriendName ?? null,
    inviteGuardianName: opts.inviteGuardianName ?? null,
    callerIdentityMode: opts.callerIdentityMode ?? null,
    callerIdentitySource: opts.callerIdentitySource ?? null,
    initiatedFromConversationId: opts.initiatedFromConversationId ?? null,
    startedAt: null,
    endedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(callSessions).values(session).run();
  return session;
}

export function getCallSession(id: string): CallSession | null {
  const db = getDb();
  const row = db
    .select()
    .from(callSessions)
    .where(eq(callSessions.id, id))
    .get();
  if (!row) return null;
  return parseCallSession(row);
}

export function getCallSessionByCallSid(callSid: string): CallSession | null {
  const db = getDb();
  const row = db
    .select()
    .from(callSessions)
    .where(eq(callSessions.providerCallSid, callSid))
    .get();
  if (!row) return null;
  return parseCallSession(row);
}

export function getActiveCallSessionForConversation(
  conversationId: string,
): CallSession | null {
  const db = getDb();
  const row = db
    .select()
    .from(callSessions)
    .where(
      and(
        or(
          eq(callSessions.conversationId, conversationId),
          eq(callSessions.initiatedFromConversationId, conversationId),
        ),
        notInArray(callSessions.status, ["completed", "failed", "cancelled"]),
      ),
    )
    .orderBy(desc(callSessions.createdAt))
    .get();
  if (!row) return null;
  return parseCallSession(row);
}

export function updateCallSession(
  id: string,
  updates: Partial<
    Pick<
      CallSession,
      | "status"
      | "providerCallSid"
      | "startedAt"
      | "endedAt"
      | "lastError"
      | "conversationId"
      | "initiatedFromConversationId"
    >
  >,
  opts?: { beforeLeaseSync?: () => void },
): void {
  const db = getDb();
  const shouldSyncActiveLease =
    Object.prototype.hasOwnProperty.call(updates, "providerCallSid") ||
    Object.prototype.hasOwnProperty.call(updates, "status");

  // Validate status transition when a new status is provided
  if (updates.status) {
    const current = getCallSession(id);
    if (current) {
      const result = validateTransition(
        current.status,
        updates.status as CallStatus,
      );
      if (!result.valid) {
        log.warn(
          {
            callSessionId: id,
            from: current.status,
            to: updates.status,
            reason: result.reason,
          },
          "Invalid call status transition — skipping update",
        );
        return;
      }
    }
  }

  db.update(callSessions)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(callSessions.id, id))
    .run();

  opts?.beforeLeaseSync?.();

  if (shouldSyncActiveLease) {
    try {
      syncActiveCallLeaseFromSession(getCallSession(id));
    } catch (err) {
      log.warn(
        { callSessionId: id, err },
        "Failed to sync active call lease from session update",
      );
    }
  }
}

// ── Recovery queries ─────────────────────────────────────────────────

/**
 * Returns all call sessions that are in a non-terminal state
 * (i.e. not completed, failed, or cancelled). Used during daemon startup
 * to reconcile in-flight calls.
 */
export function listRecoverableCalls(): CallSession[] {
  const db = getDb();
  const rows = db
    .select()
    .from(callSessions)
    .where(
      notInArray(callSessions.status, ["completed", "failed", "cancelled"]),
    )
    .all();
  return rows.map(parseCallSession);
}

// ── Call Events ──────────────────────────────────────────────────────

export function recordCallEvent(
  callSessionId: string,
  eventType: CallEventType,
  payload?: Record<string, unknown>,
): CallEvent {
  const db = getDb();
  const now = Date.now();
  const event = {
    id: uuid(),
    callSessionId,
    eventType,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: now,
  };
  db.insert(callEvents).values(event).run();
  return event;
}

export function getCallEvents(callSessionId: string): CallEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(callEvents)
    .where(eq(callEvents.callSessionId, callSessionId))
    .orderBy(callEvents.createdAt)
    .all();
  return rows.map(parseCallEvent);
}

// ── Pending Questions ────────────────────────────────────────────────

export function createPendingQuestion(
  callSessionId: string,
  questionText: string,
): CallPendingQuestion {
  const db = getDb();
  const now = Date.now();
  const question = {
    id: uuid(),
    callSessionId,
    questionText,
    status: "pending" as const,
    askedAt: now,
    answeredAt: null,
    answerText: null,
  };
  db.insert(callPendingQuestions).values(question).run();
  return question;
}

export function getPendingQuestion(
  callSessionId: string,
): CallPendingQuestion | null {
  const db = getDb();
  const row = db
    .select()
    .from(callPendingQuestions)
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, "pending"),
      ),
    )
    .orderBy(desc(callPendingQuestions.askedAt))
    .limit(1)
    .get();
  if (!row) return null;
  return parsePendingQuestion(row);
}

export function answerPendingQuestion(id: string, answerText: string): void {
  const db = getDb();
  db.update(callPendingQuestions)
    .set({
      status: "answered",
      answerText,
      answeredAt: Date.now(),
    })
    .where(
      and(
        eq(callPendingQuestions.id, id),
        eq(callPendingQuestions.status, "pending"),
      ),
    )
    .run();
  if (rawChanges() === 0) {
    log.warn(
      { questionId: id },
      "answerPendingQuestion: no rows updated — question may have already been answered or expired",
    );
  }
}

export function expirePendingQuestions(callSessionId: string): void {
  const db = getDb();
  db.update(callPendingQuestions)
    .set({ status: "expired" })
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, "pending"),
      ),
    )
    .run();
}

// ── Callback Idempotency ─────────────────────────────────────────────

/** Claims older than this are considered orphaned (crashed mid-processing) and can be reclaimed. */
const CLAIM_EXPIRY_MS = 60_000; // 60 seconds

/**
 * Build a dedupe key for a Twilio status callback.
 * Combines CallSid + CallStatus + Timestamp (or SequenceNumber if present)
 * to uniquely identify each callback.
 */
export function buildCallbackDedupeKey(
  callSid: string,
  callStatus: string,
  timestamp?: string | null,
  sequenceNumber?: string | null,
): string {
  const discriminator = sequenceNumber ?? timestamp ?? "";
  return `${callSid}:${callStatus}:${discriminator}`;
}

/**
 * Check whether a callback dedupe key has already been processed (read-only).
 * Returns true if the key already exists, false otherwise.
 */
export function isCallbackProcessed(dedupeKey: string): boolean {
  return (
    rawGet<{ 1: number }>(
      `SELECT 1 FROM processed_callbacks WHERE dedupe_key = ?`,
      dedupeKey,
    ) != null
  );
}

/**
 * Record a callback as processed. Should be called AFTER downstream writes
 * (session updates, event recording) have succeeded so that Twilio retries
 * are not silently dropped if those writes fail.
 *
 * Uses INSERT OR IGNORE so concurrent calls for the same key are safe.
 */
export function recordProcessedCallback(
  dedupeKey: string,
  callSessionId: string,
): void {
  rawRun(
    `INSERT OR IGNORE INTO processed_callbacks (id, dedupe_key, call_session_id, created_at) VALUES (?, ?, ?, ?)`,
    uuid(),
    dedupeKey,
    callSessionId,
    Date.now(),
  );
}

/**
 * Atomically claim a callback for processing. Returns a unique claim ID
 * (string) if this caller won the claim, or null if another caller already
 * claimed it (dedupe_key conflict).
 *
 * Expired orphaned claims (older than CLAIM_EXPIRY_MS) are automatically
 * cleared before attempting the insert, so crashes mid-processing don't
 * permanently block retries.
 *
 * If processing fails, call `releaseCallbackClaim(dedupeKey, claimId)` to allow retries.
 * On success, call `finalizeCallbackClaim(dedupeKey, claimId)` to make the claim permanent.
 *
 * The returned claim ID acts as an ownership token: release and finalize
 * operations require it so that handler A cannot accidentally release or
 * finalize a claim that was reclaimed by handler B after expiry.
 */
export function claimCallback(
  dedupeKey: string,
  callSessionId: string,
): string | null {
  // Clear any expired orphaned claims so they can be reprocessed
  rawRun(
    `DELETE FROM processed_callbacks WHERE dedupe_key = ? AND created_at < ?`,
    dedupeKey,
    Date.now() - CLAIM_EXPIRY_MS,
  );

  const claimId = uuid();
  const changes = rawRun(
    `INSERT OR IGNORE INTO processed_callbacks (id, dedupe_key, call_session_id, claim_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    uuid(),
    dedupeKey,
    callSessionId,
    claimId,
    Date.now(),
  );
  return changes > 0 ? claimId : null;
}

/**
 * Release a callback claim so that retries can reprocess it.
 * Called when processing fails after a successful claim.
 *
 * Only deletes the row if both dedupe_key AND claim_id match, preventing
 * handler A from releasing a claim that was reclaimed by handler B.
 */
export function releaseCallbackClaim(dedupeKey: string, claimId: string): void {
  rawRun(
    `DELETE FROM processed_callbacks WHERE dedupe_key = ? AND claim_id = ?`,
    dedupeKey,
    claimId,
  );
}

/**
 * Finalize a callback claim after successful processing.
 * Sets the created_at to a far-future value so the claim never expires,
 * distinguishing it from in-flight claims that may need to be reclaimed.
 *
 * Only updates the row if both dedupe_key AND claim_id match, preventing
 * handler A from finalizing a claim that was reclaimed by handler B.
 *
 * Returns true if the claim was successfully finalized, or false if 0 rows
 * were updated — meaning the claim was reclaimed by another handler after
 * expiry. Callers should treat a false return as a lost-claim signal: the
 * business writes already happened but the dedupe row belongs to someone
 * else, so duplicate processing may occur on later retries.
 */
export function finalizeCallbackClaim(
  dedupeKey: string,
  claimId: string,
): boolean {
  // Set created_at far in the future so expiry check never matches
  const NEVER_EXPIRE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000; // ~100 years
  const changes = rawRun(
    `UPDATE processed_callbacks SET created_at = ? WHERE dedupe_key = ? AND claim_id = ?`,
    NEVER_EXPIRE,
    dedupeKey,
    claimId,
  );
  if (changes === 0) {
    log.warn(
      { dedupeKey, claimId },
      "finalizeCallbackClaim: claim was lost — another handler reclaimed this key after expiry",
    );
    return false;
  }
  return true;
}
