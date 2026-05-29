import { groupConversationsByKey } from "@/domains/chat/utils/sub-group";
import type { SubGroup } from "@/domains/chat/utils/sub-group";
import type { Conversation } from "@/types/conversation-types";

export type ScheduledSubGroup = SubGroup;

/**
 * Derive a human-readable label for a schedule sub-group.
 *
 * Uses the first conversation's title when available, falling back to
 * a truncated version of the `scheduleJobId` (or `"Scheduled"` when
 * neither is present). This mirrors the macOS desktop behaviour where
 * the schedule group heading is the job's display name.
 */
export function formatScheduledSubGroupLabel(
  scheduleJobId: string,
  firstConversation: Conversation,
): string {
  if (firstConversation.title) {
    return firstConversation.title;
  }
  if (scheduleJobId.length > 0) {
    return scheduleJobId;
  }
  return "Scheduled";
}

/**
 * Sub-group scheduled conversations by `scheduleJobId` (matches macOS).
 *
 * Conversations without a `scheduleJobId` get a unique key so they always
 * render as a single inline row rather than being grouped under a vague label.
 * Insertion order is preserved so the caller can rely on the input order
 * for display.
 */
export function groupScheduledConversationsByJobId(
  conversations: Conversation[],
): ScheduledSubGroup[] {
  return groupConversationsByKey(
    conversations,
    (c) => c.scheduleJobId ?? "",
    (key, firstConv) => formatScheduledSubGroupLabel(key, firstConv),
  );
}
