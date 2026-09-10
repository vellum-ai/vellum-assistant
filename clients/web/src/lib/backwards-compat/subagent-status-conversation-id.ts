/**
 * Backwards-compat fallback: the parent conversation of a
 * `subagent_status_changed` that names none.
 *
 * Assistants below `MIN_VERSION` send the event with no `conversationId`, so
 * a status for a subagent the store has never seen (its `subagent_spawned`
 * was missed, or the store was reset by a conversation switch) can only be
 * scoped by guessing the conversation on screen. That guess files a subagent
 * still running in the conversation the user just left under the one they
 * opened: its card surfaces in the wrong transcript, and the reconcile that
 * follows asks about that conversation, finds no such subagent, and settles
 * it as interrupted while it is still running. An entry with no parent at all
 * is worse on those assistants: the overlay shows it in every conversation
 * and no reconcile ever settles it.
 *
 * The switch is the field, not the version: an assistant at or above
 * `MIN_VERSION` names the parent on every status emit, so this is reached
 * only for older ones. `MIN_VERSION` records when the field became
 * guaranteed, for whoever deletes this.
 *
 * Delete this module, and the fallback at its call site, once the minimum
 * supported assistant is >= MIN_VERSION.
 */
import { useConversationStore } from "@/stores/conversation-store";

export const MIN_VERSION = "0.11.12";

/**
 * The conversation on screen, as the parent of a status event that names
 * none. `undefined` with no conversation on screen: nothing to scope by.
 */
export function legacySubagentStatusParentConversationId(): string | undefined {
  return useConversationStore.getState().activeConversationId ?? undefined;
}
