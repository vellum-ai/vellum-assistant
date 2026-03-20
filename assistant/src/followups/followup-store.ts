import { and, asc, eq, lte, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { followups } from "../memory/schema.js";
import type { FollowUp, FollowUpCreateInput, FollowUpStatus } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function parseFollowUp(row: typeof followups.$inferSelect): FollowUp {
  const scheduleId = row.reminderCronId;
  return {
    id: row.id,
    channel: row.channel,
    conversationId: row.conversationId,
    contactId: row.contactId,
    sentAt: row.sentAt,
    expectedResponseBy: row.expectedResponseBy,
    status: row.status as FollowUpStatus,
    reminderScheduleId: scheduleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function createFollowUp(input: FollowUpCreateInput): FollowUp {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  db.insert(followups)
    .values({
      id,
      channel: input.channel,
      conversationId: input.conversationId,
      contactId: input.contactId ?? null,
      sentAt: input.sentAt ?? now,
      expectedResponseBy: input.expectedResponseBy ?? null,
      status: "pending",
      reminderCronId: input.reminderScheduleId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getFollowUp(id)!;
}

export function getFollowUp(id: string): FollowUp | null {
  const db = getDb();
  const row = db.select().from(followups).where(eq(followups.id, id)).get();
  if (!row) return null;
  return parseFollowUp(row);
}

export function listFollowUps(filter?: {
  status?: FollowUpStatus;
  channel?: string;
  contactId?: string;
}): FollowUp[] {
  const db = getDb();
  const conditions = [];

  if (filter?.status) {
    conditions.push(eq(followups.status, filter.status));
  }
  if (filter?.channel) {
    conditions.push(eq(followups.channel, filter.channel));
  }
  if (filter?.contactId) {
    conditions.push(eq(followups.contactId, filter.contactId));
  }

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const rows = db.select().from(followups).where(whereClause).all();

  return rows.map(parseFollowUp);
}

export function resolveFollowUp(id: string): FollowUp {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(followups)
    .where(eq(followups.id, id))
    .get();
  if (!existing) throw new Error(`Follow-up "${id}" not found`);

  db.update(followups)
    .set({ status: "resolved", updatedAt: now })
    .where(eq(followups.id, id))
    .run();

  return getFollowUp(id)!;
}

export function resolveByConversation(
  channel: string,
  conversationId: string,
): FollowUp[] {
  const db = getDb();
  const now = Date.now();

  // Find ALL pending/overdue/nudged follow-ups matching this conversation
  const rows = db
    .select()
    .from(followups)
    .where(
      and(
        eq(followups.channel, channel),
        eq(followups.conversationId, conversationId),
        or(
          eq(followups.status, "pending"),
          eq(followups.status, "overdue"),
          eq(followups.status, "nudged"),
        ),
      ),
    )
    .all();

  if (rows.length === 0) return [];

  for (const row of rows) {
    db.update(followups)
      .set({ status: "resolved", updatedAt: now })
      .where(eq(followups.id, row.id))
      .run();
  }

  return rows.map((row) => getFollowUp(row.id)!);
}

export function getOverdueFollowUps(): FollowUp[] {
  const db = getDb();
  const now = Date.now();

  const rows = db
    .select()
    .from(followups)
    .where(
      and(
        eq(followups.status, "pending"),
        lte(followups.expectedResponseBy, now),
      ),
    )
    .all();

  return rows.map(parseFollowUp);
}

export function markNudged(id: string): FollowUp {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(followups)
    .where(eq(followups.id, id))
    .get();
  if (!existing) throw new Error(`Follow-up "${id}" not found`);

  db.update(followups)
    .set({ status: "nudged", updatedAt: now })
    .where(eq(followups.id, id))
    .run();

  return getFollowUp(id)!;
}

// ── Brief Helpers ──────────────────────────────────────────────────────

/**
 * Lightweight projection of a follow-up used by the brief compiler.
 */
export interface BriefFollowUp {
  id: string;
  channel: string;
  conversationId: string;
  contactId: string | null;
  expectedResponseBy: number | null;
  status: FollowUpStatus;
  updatedAt: number;
}

/**
 * Return pending and overdue follow-ups for the brief compiler.
 * Ordered by expectedResponseBy ascending (most urgent first).
 */
export function getPendingAndOverdueFollowUps(): BriefFollowUp[] {
  const db = getDb();

  const rows = db
    .select({
      id: followups.id,
      channel: followups.channel,
      conversationId: followups.conversationId,
      contactId: followups.contactId,
      expectedResponseBy: followups.expectedResponseBy,
      status: followups.status,
      updatedAt: followups.updatedAt,
    })
    .from(followups)
    .where(
      or(
        eq(followups.status, "pending"),
        eq(followups.status, "overdue"),
        eq(followups.status, "nudged"),
      ),
    )
    .orderBy(asc(followups.expectedResponseBy))
    .all();

  return rows as BriefFollowUp[];
}
