// The canonical conversation-type union — how a conversation was created / what
// execution mode it runs in. Defined here (a leaf) so the create path in
// `conversation-crud.ts`, the notification pipeline, and read-side filters
// share one declaration without importing the heavy CRUD module. Also provides
// the shared "is this a non-interactive / background conversation?" predicate
// used by notification-feed and memory filters, plus the source-aware
// `resolveConversationKind` classifier.

/**
 * Canonical `conversations.source` string for background memory v2
 * consolidation runs. A persisted column value, so it lives with the rest of
 * the conversation vocabulary rather than inside the memory plugin that
 * writes it (persistence must not depend on a plugin).
 */
// FROZEN: persisted `conversations.source` value. Never rename it.
export const MEMORY_V2_CONSOLIDATION_SOURCE = "memory_v2_consolidation";

/** How a conversation was created / its execution mode. */
export type ConversationCreateType = "standard" | "background" | "scheduled";

/** Read-side alias of {@link ConversationCreateType}. */
export type ConversationType = ConversationCreateType;

/**
 * Conversation types created by background machinery (heartbeat runs,
 * scheduled runs, retrospective forks) rather than by a person. Exported as a
 * list so SQL filters (e.g. `notInArray`) share the same set as the predicate
 * below.
 */
export const BACKGROUND_CONVERSATION_TYPES = [
  "background",
  "scheduled",
] as const satisfies readonly ConversationType[];

// Tolerant of null/undefined/unknown strings so it can be called directly on
// raw DB column values without pre-validation.
export function isBackgroundConversationType(
  t: ConversationType | string | null | undefined,
): boolean {
  return (BACKGROUND_CONVERSATION_TYPES as readonly string[]).includes(t ?? "");
}

/**
 * Who or what drove a conversation, folding the `source` and `conversationType`
 * columns into one label.
 */
export type ConversationKind =
  | "user"
  | "background"
  | "background_memory_consolidation"
  | "scheduled";

/**
 * Single classifier shared by the LLM-context routes and the notification
 * producers, so a new background source or conversation type lands in every
 * consumer at once.
 */
export function resolveConversationKind(
  source: string,
  conversationType: string,
): ConversationKind {
  if (source === MEMORY_V2_CONSOLIDATION_SOURCE) {
    return "background_memory_consolidation";
  }
  if (conversationType === "background") {
    return "background";
  }
  if (conversationType === "scheduled") {
    return "scheduled";
  }
  return "user";
}
