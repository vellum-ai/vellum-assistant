import { and, asc, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb, rawChanges } from '../../memory/db.js';
import { reminders } from '../../memory/schema.js';
import { cast,createRowMapper, parseJson } from '../../util/row-mapper.js';

export type RoutingIntent = 'single_channel' | 'multi_channel' | 'all_channels';

export interface RoutingHints {
  [key: string]: unknown;
}

export interface ReminderRow {
  id: string;
  label: string;
  message: string;
  fireAt: number;
  mode: 'notify' | 'execute';
  status: 'pending' | 'firing' | 'fired' | 'cancelled';
  firedAt: number | null;
  conversationId: string | null;
  routingIntent: RoutingIntent;
  routingHints: RoutingHints;
  createdAt: number;
  updatedAt: number;
}

const parseRow = createRowMapper<typeof reminders.$inferSelect, ReminderRow>({
  id: 'id',
  label: 'label',
  message: 'message',
  fireAt: 'fireAt',
  mode: { from: 'mode', transform: cast<ReminderRow['mode']>() },
  status: { from: 'status', transform: cast<ReminderRow['status']>() },
  firedAt: 'firedAt',
  conversationId: 'conversationId',
  routingIntent: { from: 'routingIntent', transform: cast<RoutingIntent>() },
  routingHints: { from: 'routingHintsJson', transform: parseJson<RoutingHints>({}) },
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
});

export function insertReminder(params: {
  label: string;
  message: string;
  fireAt: number;
  mode: 'notify' | 'execute';
  routingIntent?: RoutingIntent;
  routingHints?: RoutingHints;
}): ReminderRow {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const routingIntent = params.routingIntent ?? 'all_channels';
  const routingHints = params.routingHints ?? {};
  const row = {
    id,
    label: params.label,
    message: params.message,
    fireAt: params.fireAt,
    mode: params.mode,
    status: 'pending' as const,
    firedAt: null,
    conversationId: null,
    routingIntent,
    routingHintsJson: JSON.stringify(routingHints),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(reminders).values(row).run();
  return {
    id,
    label: params.label,
    message: params.message,
    fireAt: params.fireAt,
    mode: params.mode,
    status: 'pending',
    firedAt: null,
    conversationId: null,
    routingIntent,
    routingHints,
    createdAt: now,
    updatedAt: now,
  };
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
  db
    .update(reminders)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'pending')))
    .run();
  return rawChanges() > 0;
}

/**
 * Claim all pending reminders where fire_at <= now.
 * Transitions to 'firing' (not 'fired') so the reminder stays recoverable
 * if execution fails. Call completeReminder() after successful delivery
 * to move to the terminal 'fired' state.
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
    db
      .update(reminders)
      .set({ status: 'firing', firedAt: now, updatedAt: now })
      .where(and(eq(reminders.id, row.id), eq(reminders.status, 'pending')))
      .run();

    if (rawChanges() === 0) continue;

    claimed.push(parseRow({
      ...row,
      status: 'firing',
      firedAt: now,
      updatedAt: now,
    }));
  }
  return claimed;
}

/** Mark a claimed reminder as successfully delivered. */
export function completeReminder(id: string): void {
  const db = getDb();
  db.update(reminders)
    .set({ status: 'fired', updatedAt: Date.now() })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'firing')))
    .run();
}

/** Revert a claimed reminder back to pending so it can be retried. */
export function failReminder(id: string): void {
  const db = getDb();
  db.update(reminders)
    .set({ status: 'pending', firedAt: null, updatedAt: Date.now() })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'firing')))
    .run();
}

export function setReminderConversationId(id: string, conversationId: string): void {
  const db = getDb();
  db.update(reminders)
    .set({ conversationId, updatedAt: Date.now() })
    .where(eq(reminders.id, id))
    .run();
}
