export interface AsyncChatScope {
  currentAssistantId: string | null;
  currentConversationKey: string | null;
  requestAssistantId: string;
  requestConversationKey: string;
  resolvedConversationKey?: string | null;
}

export function isAsyncChatScopeCurrent({
  currentAssistantId,
  currentConversationKey,
  requestAssistantId,
  requestConversationKey,
  resolvedConversationKey,
}: AsyncChatScope): boolean {
  if (currentAssistantId !== requestAssistantId || !currentConversationKey) {
    return false;
  }
  return (
    currentConversationKey === requestConversationKey ||
    (!!resolvedConversationKey && currentConversationKey === resolvedConversationKey)
  );
}
