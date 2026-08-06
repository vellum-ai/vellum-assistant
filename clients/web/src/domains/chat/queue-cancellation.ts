import { deleteQueuedMessage } from "@/domains/chat/api/messages";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { removeQueuedMessage } from "@/domains/chat/utils/stream-updaters/shared";
import { useConversationStore } from "@/stores/conversation-store";

interface ConfirmQueuedMessageDeletionParams {
  assistantId: string;
  conversationId: string;
  requestId: string;
  messageId: string;
  setOptimisticSends: (
    updater: (prev: DisplayMessage[]) => DisplayMessage[],
  ) => void;
  /**
   * Local bookkeeping for a confirmed cancellation. Retire correlation state
   * here, but do NOT touch the turn store's queued count: the daemon answers
   * a successful DELETE with a hub-wide `message_queued_deleted`, and
   * `handleMessageQueuedDeleted` decrements on that. The count tracks every
   * queued message in the conversation, not just this client's, because
   * `handleMessageQueued` increments for every `message_queued` regardless of
   * origin; a local decrement here would double-count the one cancellation
   * this client happened to issue and drop the queued indicator while other
   * messages are still waiting.
   */
  onDeleted: () => void;
}

export async function confirmQueuedMessageDeletion({
  assistantId,
  conversationId,
  requestId,
  messageId,
  setOptimisticSends,
  onDeleted,
}: ConfirmQueuedMessageDeletionParams): Promise<boolean> {
  const deleted = await deleteQueuedMessage(
    assistantId,
    conversationId,
    requestId,
  );
  if (!deleted) {
    return false;
  }

  if (useConversationStore.getState().activeConversationId !== conversationId) {
    return true;
  }

  const removeMessage = (prev: DisplayMessage[]) =>
    removeQueuedMessage(prev, messageId);
  setOptimisticSends(removeMessage);
  patchTranscriptMessages(removeMessage);
  onDeleted();
  return true;
}
