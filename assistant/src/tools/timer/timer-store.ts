import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../memory/db.js';
import { pomodoroTimers } from '../../memory/schema.js';

export interface TimerRow {
  id: string;
  sessionId: string;
  label: string;
  durationMinutes: number;
  startedAt: number;
  remainingMs: number;
  status: string;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function insertTimer(row: TimerRow): void {
  const db = getDb();
  db.insert(pomodoroTimers).values(row).run();
}

export function updateTimerStatus(
  id: string,
  updates: {
    status: string;
    remainingMs?: number;
    startedAt?: number;
    completedAt?: number | null;
  },
): void {
  const db = getDb();
  const set: Record<string, unknown> = {
    status: updates.status,
    updatedAt: Date.now(),
  };
  if (updates.remainingMs !== undefined) set.remainingMs = updates.remainingMs;
  if (updates.startedAt !== undefined) set.startedAt = updates.startedAt;
  if (updates.completedAt !== undefined) set.completedAt = updates.completedAt;
  db.update(pomodoroTimers).set(set).where(eq(pomodoroTimers.id, id)).run();
}

export function deleteTimer(id: string): void {
  const db = getDb();
  db.delete(pomodoroTimers).where(eq(pomodoroTimers.id, id)).run();
}

export function listTimersBySession(sessionId: string): TimerRow[] {
  const db = getDb();
  return db
    .select()
    .from(pomodoroTimers)
    .where(eq(pomodoroTimers.sessionId, sessionId))
    .all();
}

/** Load all running or paused timers (for rehydration after daemon restart). */
export function listActiveTimers(): TimerRow[] {
  const db = getDb();
  return db
    .select()
    .from(pomodoroTimers)
    .where(inArray(pomodoroTimers.status, ['running', 'paused']))
    .all();
}

/** Delete completed/cancelled timers for a session. */
export function pruneTimerRows(sessionId: string): void {
  const db = getDb();
  db.delete(pomodoroTimers)
    .where(
      and(
        eq(pomodoroTimers.sessionId, sessionId),
        inArray(pomodoroTimers.status, ['completed', 'cancelled']),
      ),
    )
    .run();
}
