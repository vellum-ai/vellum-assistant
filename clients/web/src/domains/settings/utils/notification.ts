/**
 * Shared utilities for notification rendering. Used by both the
 * header popover and the full Settings → Notifications panel.
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  organizationsNotificationsListQueryKey,
  organizationsNotificationsSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

export { formatRelativeDate } from "@/utils/format-date";

/**
 * Invalidate both notification list and summary caches. Centralizes the
 * two-key invalidation so new notification-related caches only need to be
 * added here — mirrors `invalidateConversationQueries()` from the chat domain.
 */
export function invalidateNotificationQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: organizationsNotificationsListQueryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: organizationsNotificationsSummaryRetrieveQueryKey(),
  });
}

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
