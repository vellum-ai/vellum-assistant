/**
 * Shared utilities for organization notification rendering. Used by both the
 * header popover and the full Settings → Notifications panel.
 */

import type { NotificationList } from "@/generated/api/types.gen.js";

/**
 * Formats a timestamp as a human-readable relative string such as "just now",
 * "3h ago", "in 2d". Returns an em dash for missing dates.
 *
 * Uses Math.round (not floor) for values near the hour/day boundary so small
 * scheduling drift between the caller's Date.now() and this helper's
 * new Date() doesn't turn "in 3 days" into "in 2d".
 */
export function formatRelativeDate(dateStr: string | null | undefined): string {
  if (!dateStr) {
    return "—";
  }
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const MINUTE_MS = 1000 * 60;
  const HOUR_MS = MINUTE_MS * 60;
  const DAY_MINUTES = 60 * 24;
  const DAY_MS = MINUTE_MS * DAY_MINUTES;

  if (diffMs < 0) {
    const absDiffMs = -diffMs;
    if (absDiffMs < HOUR_MS) {
      return "in <1h";
    }
    const roundedMinutes = Math.round(absDiffMs / MINUTE_MS);
    const hours = Math.round(roundedMinutes / 60);
    if (hours < 24) {
      return `in ${hours}h`;
    }
    return `in ${Math.round(roundedMinutes / DAY_MINUTES)}d`;
  }

  const diffDays = Math.floor(diffMs / DAY_MS);
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / HOUR_MS);
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return diffMins <= 1 ? "just now" : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString();
}

export function isSnoozed(notification: NotificationList): boolean {
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
