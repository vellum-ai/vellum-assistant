/**
 * CRUD operations for notification preferences.
 *
 * Each row controls whether a specific notification type is enabled
 * for delivery on a specific channel. Follows the same store pattern
 * as reminder-store.ts.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { notificationPreferences } from '../memory/schema.js';
import type { NotificationType, NotificationChannel } from './types.js';

export interface NotificationPreferenceRow {
  assistantId: string;
  notificationType: string;
  channel: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToPreference(row: typeof notificationPreferences.$inferSelect): NotificationPreferenceRow {
  return {
    assistantId: row.assistantId,
    notificationType: row.notificationType,
    channel: row.channel,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Get all notification preferences for an assistant. */
export function getPreferences(assistantId: string): NotificationPreferenceRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.assistantId, assistantId))
    .all();
  return rows.map(rowToPreference);
}

/** Set a single notification preference (upsert). */
export function setPreference(
  assistantId: string,
  notificationType: NotificationType,
  channel: NotificationChannel,
  enabled: boolean,
): NotificationPreferenceRow {
  const db = getDb();
  const now = Date.now();
  const enabledInt = enabled ? 1 : 0;

  // Try update first
  const result = db
    .update(notificationPreferences)
    .set({ enabled: enabledInt, updatedAt: now })
    .where(
      and(
        eq(notificationPreferences.assistantId, assistantId),
        eq(notificationPreferences.notificationType, notificationType),
        eq(notificationPreferences.channel, channel),
      ),
    )
    .run() as unknown as { changes?: number };

  if ((result.changes ?? 0) === 0) {
    db.insert(notificationPreferences)
      .values({
        assistantId,
        notificationType,
        channel,
        enabled: enabledInt,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return {
    assistantId,
    notificationType,
    channel,
    enabled,
    createdAt: now,
    updatedAt: now,
  };
}

/** Set multiple preferences at once (upsert each). */
export function setBulkPreferences(
  assistantId: string,
  prefs: Array<{ notificationType: NotificationType; channel: NotificationChannel; enabled: boolean }>,
): NotificationPreferenceRow[] {
  return prefs.map((p) => setPreference(assistantId, p.notificationType, p.channel, p.enabled));
}

/** Get all channels that are enabled for a given notification type. */
export function getEnabledChannels(
  assistantId: string,
  notificationType: NotificationType,
): NotificationChannel[] {
  const db = getDb();
  const rows = db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.assistantId, assistantId),
        eq(notificationPreferences.notificationType, notificationType),
        eq(notificationPreferences.enabled, 1),
      ),
    )
    .all();
  return rows.map((r) => r.channel as NotificationChannel);
}
