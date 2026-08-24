/**
 * Which conversation the companion surface's composer is talking to.
 *
 * **Type is one thread for as long as the card is open.** The surface never
 * learns a conversation id: it says only whether it is starting one or
 * continuing the one it started, and this app is the side that mints them. So
 * the id has to be remembered somewhere between the message that starts the
 * thread and the ones that continue it, and that memory has to survive the
 * first message re-keying the conversation underneath it.
 *
 * It does re-key. The first message goes to a client-minted draft id, and the
 * send swaps that for the id the server assigns
 * (`use-send-message.ts`). A memory left holding the draft is holding an id
 * that no longer exists, and the next message mints a whole new conversation
 * for itself rather than landing in the one the user was typing to.
 * {@link resolveCompanionDraftConversationId} is what keeps it in step, and it
 * is called from the same place, and for the same reason, as
 * `resolveEditChatDraftConversationId`.
 *
 * Module state rather than a store: nothing renders from it. It is read once
 * inside the command that sends a message and written once on the way out, and
 * a store would be publishing a value with no subscribers.
 */
let conversationId: string | null = null;

/**
 * The conversation the open composer is talking to, or null when it has not
 * sent anything yet.
 */
export function getCompanionConversationId(): string | null {
  return conversationId;
}

/** Remember the conversation this surface's messages are going to. */
export function setCompanionConversationId(id: string | null): void {
  conversationId = id;
}

/**
 * Follow the companion's conversation through a draft to server-id
 * resolution.
 *
 * A no-op unless the draft being resolved is the one this surface is talking
 * to: every send in the app resolves its own draft, and only one of them is
 * ever the composer's.
 */
export function resolveCompanionDraftConversationId(
  oldConversationId: string,
  newConversationId: string,
): void {
  if (conversationId !== oldConversationId) {
    return;
  }
  conversationId = newConversationId;
}
