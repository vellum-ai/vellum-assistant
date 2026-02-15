import { and, asc, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../../memory/db.js';
import { reminders } from '../../memory/schema.js';

export interface ReminderRow {
  id: string;
  label: string;
  message: string;
  fireAt: number;
  mode: 'notify' | 'execute';
  status: 'pending' | 'fired' | 'cancelled';
  firedAt: number | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function insertReminder(params: {
  label: string;
  message: string;
  fireAt: number;
  mode: 'notify' | 'execute';
}): ReminderRow {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const row: ReminderRow = {
    id,
    label: params.label,
    message: params.message,
    fireAt: params.fireAt,
    mode: params.mode,
    status: 'pending',
    firedAt: null,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(reminders).values(row).run();
  return row;
}

export function getReminder(id: string): ReminderRow | null {
  const db = getDb();
  const row = db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!row) return null;
  return parseRow(row);
}

export function listReminders(options?: { pendingOnly?: boolean }): ReminderRow[] {
  const db = getDb();
  const conditions = options?.pendingOnly ? eq(reminders.status, 'pending') : undefined;
  const rows = db
    .select()
    .from(reminders)
    .where(conditions)
    .orderBy(asc(reminders.fireAt))
    .all();
  return rows.map(parseRow);
}

export function cancelReminder(id: string): boolean {
  const db = getDb();
  const now = Date.now();
  const result = db
    .update(reminders)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'pending')))
    .run() as unknown as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/**
 * Claim all pending reminders where fire_at <= now.
 * Uses optimistic locking: UPDATE ... SET status='fired' WHERE status='pending' AND id=?
 * Same pattern as claimDueSchedules in schedule-store.ts.
 */
export function claimDueReminders(now: number): ReminderRow[] {
  const db = getDb();
  const candidates = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.status, 'pending'), lte(reminders.fireAt, now)))
    .orderBy(asc(reminders.fireAt))
    .all();

  const claimed: ReminderRow[] = [];
  for (const row of candidates) {
    const result = db
      .update(reminders)
      .set({ status: 'fired', firedAt: now, updatedAt: now })
      .where(and(eq(reminders.id, row.id), eq(reminders.status, 'pending')))
      .run() as unknown as { changes?: number };

    if ((result.changes ?? 0) === 0) continue;

    claimed.push(parseRow({
      ...row,
      status: 'fired',
      firedAt: now,
      updatedAt: now,
    }));
  }
  return claimed;
}

export function setReminderConversationId(id: string, conversationId: string): void {
  const db = getDb();
  db.update(reminders)
    .set({ conversationId, updatedAt: Date.now() })
    .where(eq(reminders.id, id))
    .run();
}

function parseRow(row: typeof reminders.$inferSelect): ReminderRow {
  return {
    id: row.id,
    label: row.label,
    message: row.message,
    fireAt: row.fireAt,
    mode: row.mode as ReminderRow['mode'],
    status: row.status as ReminderRow['status'],
    firedAt: row.firedAt,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
