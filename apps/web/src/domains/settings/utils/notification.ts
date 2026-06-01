/**
 * Shared utilities for notification rendering. Used by both the
 * header popover and the full Settings → Notifications panel.
 */

export { formatRelativeDate } from "@/utils/format-date";

export interface SnoozableNotification {
  snoozed_until?: string | null;
}

export function isSnoozed(notification: SnoozableNotification): boolean {
  if (!notification.snoozed_until) {
    return false;
  }
  return new Date(notification.snoozed_until) > new Date();
}

export const SNOOZE_OPTIONS: ReadonlyArray<{ label: string; hours: number }> = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "24 hours", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
];
