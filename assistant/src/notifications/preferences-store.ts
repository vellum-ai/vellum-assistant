/**
 * CRUD operations for notification preferences.
 *
 * Each row stores a natural-language notification preference expressed by
 * the user (e.g. "Use Telegram for urgent alerts"), along with structured
 * conditions for when the preference applies and a priority for conflict
 * resolution.
 */

import { desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { notificationPreferences } from "../memory/schema.js";

// ── Row type ────────────────────────────────────────────────────────────

export interface NotificationPreferenceRow {
  id: string;
  preferenceText: string;
  appliesWhenJson: string; // serialised JSON
  priority: number;
  createdAt: number;
  updatedAt: number;
}

function rowToPreference(
  row: typeof notificationPreferences.$inferSelect,
): NotificationPreferenceRow {
  return {
    id: row.id,
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
  channels?: string[]; // e.g. ["telegram", "vellum"]
  urgencyLevels?: string[]; // e.g. ["high", "critical"]
  contexts?: string[]; // e.g. ["work_calls", "meetings"]
  [key: string]: unknown;
}

// ── Create ──────────────────────────────────────────────────────────────

export interface CreatePreferenceParams {
  preferenceText: string;
  appliesWhen?: AppliesWhenConditions;
  priority?: number;
}

export function createPreference(
  params: CreatePreferenceParams,
): NotificationPreferenceRow {
  const db = getDb();
  const now = Date.now();

  const row = {
    id: uuid(),
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

export function listPreferences(): NotificationPreferenceRow[] {
  const db = getDb();

  const rows = db
    .select()
    .from(notificationPreferences)
    .orderBy(desc(notificationPreferences.priority))
    .all();

  return rows.map(rowToPreference);
}
