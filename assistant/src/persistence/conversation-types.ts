// The canonical conversation-type union — how a conversation was created / what
// execution mode it runs in. Defined here (a leaf) so the create path in
// `conversation-crud.ts`, the notification pipeline, and read-side filters
// share one declaration without importing the heavy CRUD module. Also provides
// the shared "is this a non-interactive / background conversation?" predicate
// used by notification-feed and memory filters.

/** How a conversation was created / its execution mode. */
export type ConversationCreateType = "standard" | "background" | "scheduled";

/** Read-side alias of {@link ConversationCreateType}. */
export type ConversationType = ConversationCreateType;

// Tolerant of null/undefined/unknown strings so it can be called directly on
// raw DB column values without pre-validation.
export function isBackgroundConversationType(
  t: ConversationType | string | null | undefined,
): boolean {
  return t === "background" || t === "scheduled";
}
