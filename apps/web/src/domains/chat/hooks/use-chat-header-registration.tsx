/**
 * Writes chat-specific header data to the layout slots store so
 * ChatConversationHeader (rendered by ChatLayout) can build the
 * complete actions menu without duplicating hooks or state.
 *
 * Owns:
 * - `headerSupplements` computation and slot registration
 * - `topBarRightSlot` (ConversationAssetsPill) computation and registration
 * - Slack conversation display derivation for the header label
 */

import { useCallback, useEffect, useMemo } from "react";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import type { ChatHeaderSupplements } from "@/components/layout/chat-layout-slots-store";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useSlackConversationDisplay } from "@/domains/chat/hooks/use-slack-conversation-display";
import {
  formatSlackConversationDisplayLabel,
} from "@/domains/chat/utils/slack-conversation-display";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import { IncognitoBadge } from "@/domains/chat/components/incognito-badge";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import type { Conversation } from "@/types/conversation-types";

export interface UseChatHeaderRegistrationOptions {
  assetsRefreshKey: number;
  handleAnalyzeConversation: (conversation: Conversation) => Promise<void>;
  handleForkConversationFromMenu: () => void;
  handleOpenInNewWindow: (conversation: Conversation) => void;
  handleInspectConversation: (conversation: Conversation) => void;
  handleCopyConversation: () => void;
  refreshLatestMessages: () => void;
}

export function useChatHeaderRegistration({
  assetsRefreshKey,
  handleAnalyzeConversation,
  handleForkConversationFromMenu,
  handleOpenInNewWindow,
  handleInspectConversation,
  handleCopyConversation,
  refreshLatestMessages,
}: UseChatHeaderRegistrationOptions): void {
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const messages = useChatSessionStore.use.messages();
  const setTopBarRightSlot = useChatLayoutSlotsStore.use.setTopBarRightSlot();
  const setHeaderSupplements = useChatLayoutSlotsStore.use.setHeaderSupplements();

  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);

  // Incognito badge gating — flag + (server-backed conversation flag OR
  // client draft setting for not-yet-sent conversations). Subscribing to the
  // settings map keeps the badge reactive as drafts toggle incognito.
  const incognitoFlagEnabled = useAssistantFeatureFlagStore.use.incognitoConversations();
  const conversationSettings = useConversationStore.use.conversationSettings();
  const isIncognito =
    activeConversation?.incognito ??
    (activeConversationId
      ? conversationSettings.get(activeConversationId)?.incognito ?? false
      : false);

  // Slack header label derivation
  const slackConversationDisplay = useSlackConversationDisplay({
    assistantId: assistantId ?? undefined,
    conversation: activeConversation,
    messages,
  });
  const slackHeaderLabel = useMemo(() => {
    return slackConversationDisplay
      ? formatSlackConversationDisplayLabel(slackConversationDisplay)
      : null;
  }, [slackConversationDisplay]);

  // Header supplements — chat-specific data for the conversation header menu
  const hasPersistedMessage = useMemo(
    () => messages.some((m) => m.id != null),
    [messages],
  );

  const headerSupplements = useMemo<ChatHeaderSupplements>(() => ({
    hasPersistedMessage,
    slackHeaderLabel,
    onAnalyze: handleAnalyzeConversation,
    onForkConversation: handleForkConversationFromMenu,
    onOpenInNewWindow: handleOpenInNewWindow,
    onInspect: handleInspectConversation,
    onCopyConversation: messages.length > 0 ? handleCopyConversation : null,
    onRefresh: refreshLatestMessages,
  }), [
    hasPersistedMessage,
    slackHeaderLabel,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    messages.length,
    refreshLatestMessages,
  ]);

  useEffect(() => {
    setHeaderSupplements(headerSupplements);
    return () => { setHeaderSupplements(null); };
  }, [headerSupplements, setHeaderSupplements]);

  // Top bar right slot — ConversationAssetsPill
  const handleOpenAppFromChat = useOpenAppFromChat();
  const handleOpenDocument = useCallback(
    (surfaceId: string) => {
      haptic.light();
      if (assistantId) void useViewerStore.getState().loadDocument(assistantId, surfaceId);
    },
    [assistantId],
  );

  const showIncognitoBadge = incognitoFlagEnabled && isIncognito;

  const topBarRightContent = useMemo(() => {
    if (!activeConversation?.conversationId || !assistantId) return null;
    return (
      <div className="flex items-center gap-[8px]">
        {showIncognitoBadge ? <IncognitoBadge /> : null}
        <ConversationAssetsPill
          assistantId={assistantId}
          conversationId={activeConversation.conversationId}
          refreshKey={assetsRefreshKey}
          onOpenApp={handleOpenAppFromChat}
          onOpenDocument={handleOpenDocument}
        />
      </div>
    );
  }, [activeConversation?.conversationId, assistantId, assetsRefreshKey, handleOpenAppFromChat, handleOpenDocument, showIncognitoBadge]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => { setTopBarRightSlot(null); };
  }, [topBarRightContent, setTopBarRightSlot]);

}
