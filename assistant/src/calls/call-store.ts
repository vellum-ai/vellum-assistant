import { eq, and, notInArray, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { callSessions, callEvents, callPendingQuestions } from '../memory/schema.js';
import type { CallSession, CallEvent, CallPendingQuestion, CallEventType, CallStatus } from './types.js';
import { validateTransition } from './call-state-machine.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('call-store');

// ── Helpers ──────────────────────────────────────────────────────────

function parseCallSession(row: typeof callSessions.$inferSelect): CallSession {
  return {
    id: row.id,
    conversationId: row.conversationId,
    provider: row.provider,
    providerCallSid: row.providerCallSid,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    task: row.task,
    status: row.status as CallSession['status'],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCallEvent(row: typeof callEvents.$inferSelect): CallEvent {
  return {
    id: row.id,
    callSessionId: row.callSessionId,
    eventType: row.eventType as CallEvent['eventType'],
    payloadJson: row.payloadJson,
    createdAt: row.createdAt,
  };
}

function parsePendingQuestion(row: typeof callPendingQuestions.$inferSelect): CallPendingQuestion {
  return {
    id: row.id,
    callSessionId: row.callSessionId,
    questionText: row.questionText,
    status: row.status as CallPendingQuestion['status'],
    askedAt: row.askedAt,
    answeredAt: row.answeredAt,
    answerText: row.answerText,
  };
}

// ── Call Sessions ────────────────────────────────────────────────────

export function createCallSession(opts: {
  conversationId: string;
  provider: string;
  fromNumber: string;
  toNumber: string;
  task?: string;
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
    status: 'initiated' as const,
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
  const row = db.select().from(callSessions).where(eq(callSessions.id, id)).get();
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

export function getActiveCallSessionForConversation(conversationId: string): CallSession | null {
  const db = getDb();
  const row = db
    .select()
    .from(callSessions)
    .where(
      and(
        eq(callSessions.conversationId, conversationId),
        notInArray(callSessions.status, ['completed', 'failed', 'cancelled']),
      ),
    )
    .orderBy(desc(callSessions.createdAt))
    .get();
  if (!row) return null;
  return parseCallSession(row);
}

export function updateCallSession(
  id: string,
  updates: Partial<Pick<CallSession, 'status' | 'providerCallSid' | 'startedAt' | 'endedAt' | 'lastError'>>,
): void {
  const db = getDb();

  // Validate status transition when a new status is provided
  if (updates.status) {
    const current = getCallSession(id);
    if (current) {
      const result = validateTransition(current.status, updates.status as CallStatus);
      if (!result.valid) {
        log.warn({ callSessionId: id, from: current.status, to: updates.status, reason: result.reason }, 'Invalid call status transition — skipping update');
        return;
      }
    }
  }

  db.update(callSessions)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(callSessions.id, id))
    .run();
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
      notInArray(callSessions.status, ['completed', 'failed', 'cancelled']),
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

export function createPendingQuestion(callSessionId: string, questionText: string): CallPendingQuestion {
  const db = getDb();
  const now = Date.now();
  const question = {
    id: uuid(),
    callSessionId,
    questionText,
    status: 'pending' as const,
    askedAt: now,
    answeredAt: null,
    answerText: null,
  };
  db.insert(callPendingQuestions).values(question).run();
  return question;
}

export function getPendingQuestion(callSessionId: string): CallPendingQuestion | null {
  const db = getDb();
  const row = db
    .select()
    .from(callPendingQuestions)
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, 'pending'),
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
      status: 'answered',
      answerText,
      answeredAt: Date.now(),
    })
    .where(
      and(
        eq(callPendingQuestions.id, id),
        eq(callPendingQuestions.status, 'pending'),
      ),
    )
    .run();
  // Drizzle's .run() returns void for bun:sqlite, so check affected rows via raw client.
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const changes = raw.query('SELECT changes() as c').get() as { c: number };
  if (changes.c === 0) {
    log.warn({ questionId: id }, 'answerPendingQuestion: no rows updated — question may have already been answered or expired');
  }
}

export function expirePendingQuestions(callSessionId: string): void {
  const db = getDb();
  db.update(callPendingQuestions)
    .set({ status: 'expired' })
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, 'pending'),
      ),
    )
    .run();
}

// ── Callback Idempotency ─────────────────────────────────────────────

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
  const discriminator = sequenceNumber ?? timestamp ?? '';
  return `${callSid}:${callStatus}:${discriminator}`;
}

/**
 * Check whether a callback dedupe key has already been processed (read-only).
 * Returns true if the key already exists, false otherwise.
 */
export function isCallbackProcessed(dedupeKey: string): boolean {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

  const row = raw.query(
    `SELECT 1 FROM processed_callbacks WHERE dedupe_key = ?`,
  ).get(dedupeKey);
  return row != null;
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
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

  raw.query(
    `INSERT OR IGNORE INTO processed_callbacks (id, dedupe_key, call_session_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(uuid(), dedupeKey, callSessionId, Date.now());
}

/**
 * Try to record a processed callback. Returns true if this is a new callback
 * (inserted successfully). Returns false if the callback was already processed
 * (dedupe key already exists), indicating a replay.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING pattern for atomicity.
 *
 * @deprecated Use claimCallback + releaseCallbackClaim instead to
 * atomically claim a callback and release on failure.
 */
export function tryRecordProcessedCallback(
  dedupeKey: string,
  callSessionId: string,
): boolean {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

  raw.query(
    `INSERT OR IGNORE INTO processed_callbacks (id, dedupe_key, call_session_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(uuid(), dedupeKey, callSessionId, Date.now());

  const changes = raw.query('SELECT changes() as c').get() as { c: number };
  return changes.c > 0;
}

/**
 * How long a callback claim is considered valid before it expires.
 * If a process crashes after claiming but before the catch block releases,
 * the claim becomes stale after this TTL and Twilio retries can re-claim it.
 * Default: 5 minutes (300 000 ms).
 */
export const CALLBACK_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Atomically claim a callback for processing. Returns true if this caller
 * won the claim (INSERT succeeded or an expired claim was replaced).
 * Returns false if another caller holds a non-expired claim.
 *
 * Uses a lease/expiry pattern: claims older than CALLBACK_CLAIM_TTL_MS are
 * treated as orphaned (e.g. from a crashed process) and can be re-claimed.
 * This prevents hard crashes from permanently dropping callbacks.
 *
 * If processing fails, call `releaseCallbackClaim(dedupeKey)` to allow
 * immediate retries without waiting for TTL expiry.
 */
export function claimCallback(dedupeKey: string, callSessionId: string): boolean {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const now = Date.now();

  // Try fresh insert first (fast path for new callbacks)
  raw.query(
    `INSERT OR IGNORE INTO processed_callbacks (id, dedupe_key, call_session_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(uuid(), dedupeKey, callSessionId, now);
  const insertChanges = raw.query('SELECT changes() as c').get() as { c: number };
  if (insertChanges.c > 0) return true;

  // Existing claim found — check if it has expired (orphaned by a crash)
  const expiryCutoff = now - CALLBACK_CLAIM_TTL_MS;
  raw.query(
    `UPDATE processed_callbacks SET id = ?, call_session_id = ?, created_at = ? WHERE dedupe_key = ? AND created_at < ?`,
  ).run(uuid(), callSessionId, now, dedupeKey, expiryCutoff);
  const updateChanges = raw.query('SELECT changes() as c').get() as { c: number };
  return updateChanges.c > 0;
}

/**
 * Release a callback claim so that retries can reprocess it.
 * Called when processing fails after a successful claim.
 */
export function releaseCallbackClaim(dedupeKey: string): void {
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  raw.query(`DELETE FROM processed_callbacks WHERE dedupe_key = ?`).run(dedupeKey);
}
