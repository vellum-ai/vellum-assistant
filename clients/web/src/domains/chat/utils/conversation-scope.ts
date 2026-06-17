export interface AsyncChatScope {
  currentAssistantId: string | null;
  currentConversationId: string | null;
  requestAssistantId: string;
  requestConversationId: string;
  resolvedConversationId?: string | null;
}

export function isAsyncChatScopeCurrent({
  currentAssistantId,
  currentConversationId,
  requestAssistantId,
  requestConversationId,
  resolvedConversationId,
}: AsyncChatScope): boolean {
  if (currentAssistantId !== requestAssistantId || !currentConversationId) {
    return false;
  }
  return (
    currentConversationId === requestConversationId ||
    (!!resolvedConversationId && currentConversationId === resolvedConversationId)
  );
}
