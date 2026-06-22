import { groupConversationsByKey } from "@/domains/chat/utils/sub-group";
import type { SubGroup } from "@/domains/chat/utils/sub-group";
import type { Conversation } from "@/types/conversation-types";

export type BackgroundSubGroup = SubGroup;

/**
 * Format a `source` value into a sidebar sub-group label.
 *
 * - `"auto-analysis"` renders as `"Reflections"` (matches the macOS desktop app).
 * - Empty strings render as `"Other"` (not normally displayed — sourceless
 *   conversations get a unique key so they render inline as a single row).
 * - Other values are capitalized (e.g. `"heartbeat"` -> `"Heartbeat"`).
 */
export function formatBackgroundSubGroupLabel(source: string): string {
  if (source === "auto-analysis") {
    return "Reflections";
  }
  if (source.length === 0) {
    return "Other";
  }
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Sub-group background conversations by `source` (matches macOS).
 *
 * Conversations without a `source` get a unique key so they always render
 * as a single inline row rather than being grouped under a vague label.
 * Insertion order is preserved so the caller can rely on the input order
 * for display.
 */
export function groupBackgroundConversationsBySource(
  conversations: Conversation[],
): BackgroundSubGroup[] {
  return groupConversationsByKey(
    conversations,
    (c) => c.source ?? "",
    (key) => formatBackgroundSubGroupLabel(key),
  );
}
