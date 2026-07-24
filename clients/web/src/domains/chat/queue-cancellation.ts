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
