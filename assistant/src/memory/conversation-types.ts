// Re-exports the canonical conversation-type union (defined alongside the
// create path in `conversation-crud.ts`) under a read-side name and provides
// the shared "is this a non-interactive / background conversation?" predicate
// used by notification-feed and memory filters.

import type { ConversationCreateType } from "./conversation-crud.js";

export type ConversationType = ConversationCreateType;

export const BACKGROUND_CONVERSATION_TYPES = [
  "background",
  "scheduled",
] as const;

// Tolerant of null/undefined/unknown strings so it can be called directly on
// raw DB column values without pre-validation.
export function isBackgroundConversationType(
  t: ConversationType | string | null | undefined,
): boolean {
  return t === "background" || t === "scheduled";
}
