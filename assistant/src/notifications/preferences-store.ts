/**
 * CRUD operations for notification preferences.
 *
 * Each row stores a natural-language notification preference expressed by
 * the user (e.g. "Use Telegram for urgent alerts"), along with structured
 * conditions for when the preference applies and a priority for conflict
 * resolution.
 */

import { desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { notificationPreferences } from '../memory/schema.js';

// ── Row type ────────────────────────────────────────────────────────────

export interface NotificationPreferenceRow {
  id: string;
  assistantId: string;
  preferenceText: string;
  appliesWhenJson: string; // serialised JSON
  priority: number;
  createdAt: number;
  updatedAt: number;
}

function rowToPreference(row: typeof notificationPreferences.$inferSelect): NotificationPreferenceRow {
  return {
    id: row.id,
    assistantId: row.assistantId,
    preferenceText: row.preferenceText,
    appliesWhenJson: row.appliesWhenJson,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Structured conditions type ──────────────────────────────────────────

export interface AppliesWhenConditions {
  timeRange?: { after?: string; before?: string }; // e.g. "22:00", "06:00"
  channels?: string[];        // e.g. ["telegram", "vellum"]
  urgencyLevels?: string[];   // e.g. ["high", "critical"]
  contexts?: string[];        // e.g. ["work_calls", "meetings"]
  [key: string]: unknown;
}

// ── Create ──────────────────────────────────────────────────────────────

export interface CreatePreferenceParams {
  assistantId: string;
  preferenceText: string;
  appliesWhen?: AppliesWhenConditions;
  priority?: number;
}

export function createPreference(params: CreatePreferenceParams): NotificationPreferenceRow {
  const db = getDb();
  const now = Date.now();

  const row = {
    id: uuid(),
    assistantId: params.assistantId,
    preferenceText: params.preferenceText,
    appliesWhenJson: JSON.stringify(params.appliesWhen ?? {}),
    priority: params.priority ?? 0,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(notificationPreferences).values(row).run();

  return row;
}

// ── List ────────────────────────────────────────────────────────────────

export function listPreferences(assistantId: string): NotificationPreferenceRow[] {
  const db = getDb();

  const rows = db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.assistantId, assistantId))
    .orderBy(desc(notificationPreferences.priority))
    .all();

  return rows.map(rowToPreference);
}

// ── Update ──────────────────────────────────────────────────────────────

export interface UpdatePreferenceParams {
  preferenceText?: string;
  appliesWhen?: AppliesWhenConditions;
  priority?: number;
}

export function updatePreference(id: string, params: UpdatePreferenceParams): boolean {
  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = { updatedAt: now };
  if (params.preferenceText !== undefined) updates.preferenceText = params.preferenceText;
  if (params.appliesWhen !== undefined) updates.appliesWhenJson = JSON.stringify(params.appliesWhen);
  if (params.priority !== undefined) updates.priority = params.priority;

  const result = db
    .update(notificationPreferences)
    .set(updates)
    .where(eq(notificationPreferences.id, id))
    .run() as unknown as { changes?: number };

  return (result.changes ?? 0) > 0;
}

// ── Delete ──────────────────────────────────────────────────────────────

export function deletePreference(id: string): boolean {
  const db = getDb();

  const result = db
    .delete(notificationPreferences)
    .where(eq(notificationPreferences.id, id))
    .run() as unknown as { changes?: number };

  return (result.changes ?? 0) > 0;
}

// ── Get by ID ───────────────────────────────────────────────────────────

export function getPreferenceById(id: string): NotificationPreferenceRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.id, id))
    .get();
  if (!row) return null;
  return rowToPreference(row);
}
