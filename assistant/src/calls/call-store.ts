import { eq, and, notInArray, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { callSessions, callEvents, callPendingQuestions, processedCallbacks } from '../memory/schema.js';
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
 * Try to record a processed callback. Returns true if this is a new callback
 * (inserted successfully). Returns false if the callback was already processed
 * (dedupe key already exists), indicating a replay.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING pattern for atomicity.
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
