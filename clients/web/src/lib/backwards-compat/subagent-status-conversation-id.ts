/**
 * Backwards-compat fallback: the parent conversation of a
 * `subagent_status_changed` from an assistant that scopes no envelope.
 *
 * `subagent_status_changed` names no conversation in its payload, so the
 * parent is the one the SSE envelope was scoped to. Assistants that predate
 * `conversationEventSink` scope the envelope for events whose payload carries
 * a conversation and leave these unscoped, so a status for a subagent the
 * store has never seen (its `subagent_spawned` was missed, or the store was
 * reset by a conversation switch) has nothing to file it under.
 *
 * The conversation on screen is what is left to guess from, and it is wrong
 * whenever the subagent belongs to a conversation the user has left: the card
 * surfaces in the wrong transcript, and the reconcile that follows asks about
 * that conversation, finds no such subagent, and settles it as interrupted
 * while it is still running. It stays the fallback anyway because an entry
 * with no parent at all is worse on those assistants: the overlay shows it in
 * every conversation and no reconcile ever settles it.
 *
 * No version read: whether the envelope carries a conversation is the switch,
 * and the envelope answers it per event. Delete this module, and the fallback
 * at its call site, once every supported assistant scopes these envelopes.
 */
import { useConversationStore } from "@/stores/conversation-store";

/**
 * The conversation on screen, as the parent of a status event the transport
 * left unscoped. `undefined` with no conversation on screen: nothing to scope
 * by.
 */
export function legacySubagentStatusParentConversationId(): string | undefined {
  return useConversationStore.getState().activeConversationId ?? undefined;
}
