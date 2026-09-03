/**
 * Starting a conversation the user is not looking at.
 *
 * A background launch mints a conversation, links it somewhere, and sends one
 * prompt into it, all while the surface that triggered it stays on screen and
 * the visible conversation is left alone. That is deliberately NOT
 * `prepareFreshConversation()` from `conversation-navigation.ts`: that helper
 * selects the new draft and reveals the chat, which is right for "new chat"
 * and wrong here, since it would swap the transcript under an open modal while
 * the URL still points at the conversation the user was reading.
 *
 * The seam lives in `utils/` so a feature domain can reach it without
 * importing the chat domain. The conversation is a real conversation: it lands
 * in the sidebar list once the daemon persists its first message, and opening
 * it later streams like any other.
 */

import {
  postChatMessage,
  type PostMessageResult,
} from "@/domains/chat/api/messages";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Mint a conversation id for a turn that starts in the background.
 *
 * Registered as a draft the same way every other fresh key is, so the surfaces
 * that treat an unsent key as a draft agree about this one. Returning the id
 * before anything is sent lets the caller record the link first, which matters
 * whenever a turn can complete before the send call resolves.
 */
export function mintBackgroundConversationId(): string {
  return createDraftConversationId();
}

export interface SendBackgroundPromptArgs {
  assistantId: string;
  /** A key from {@link mintBackgroundConversationId}. */
  conversationId: string;
  prompt: string;
}

/**
 * Send one prompt into a background conversation.
 *
 * Retires the draft mark on the id the daemon resolved, the same way
 * `use-send-message` does for a foreground send: the POST answering means the
 * row exists, and a key still marked draft describes a conversation that is no
 * longer new. The list reconcile would eventually heal it, but only after the
 * next list refetch.
 */
export async function sendBackgroundPrompt({
  assistantId,
  conversationId,
  prompt,
}: SendBackgroundPromptArgs): Promise<PostMessageResult> {
  const result = await postChatMessage(assistantId, conversationId, prompt);
  if (result.ok) {
    useConversationStore
      .getState()
      .clearDraftConversationId(result.conversationId);
  }
  return result;
}
