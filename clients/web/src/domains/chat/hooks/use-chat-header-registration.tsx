/**
 * Writes chat-specific header data to the layout slots store so
 * ChatConversationHeader (rendered by ChatLayout) can build the
 * complete actions menu without duplicating hooks or state.
 *
 * Owns:
 * - `headerSupplements` computation and slot registration
 * - `topBarRightSlot` (ChannelSourceLinkPill + ConversationAssetsPill +
 *   InChatPluginPill) computation and registration
 * - Slack conversation display derivation for the header label and the
 *   source-thread link
 */

import { useCallback, useEffect, useMemo } from "react";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import type { ChatHeaderSupplements } from "@/components/layout/chat-layout-slots-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useSlackConversationDisplay } from "@/domains/chat/hooks/use-slack-conversation-display";
import {
  formatSlackConversationDisplayLabel,
} from "@/domains/chat/utils/slack-conversation-display";
import { getSlackLinkUrl } from "@/domains/chat/types/types";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { getChannelBindingDisplayText } from "@/domains/chat/utils/channel-conversation-display";
import { getChannelLabel } from "@/utils/channel-presentation";
import { ChannelSourceLinkPill } from "@/domains/chat/components/channel-source-link-pill";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import { InChatPluginPill } from "@/domains/chat/components/inchat-plugin-pill/inchat-plugin-pill";
import { useSupportsInchatPluginEdit } from "@/lib/backwards-compat/use-supports-inchat-plugin-edit";
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
  onRefresh: () => void;
}

export function useChatHeaderRegistration({
  assetsRefreshKey,
  handleAnalyzeConversation,
  handleForkConversationFromMenu,
  handleOpenInNewWindow,
  handleInspectConversation,
  handleCopyConversation,
  onRefresh,
}: UseChatHeaderRegistrationOptions): void {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const messages = useTranscriptMessages();
  const setTopBarRightSlot = useChatLayoutSlotsStore.use.setTopBarRightSlot();
  const setHeaderSupplements = useChatLayoutSlotsStore.use.setHeaderSupplements();
  // Older daemons omit `enabledPlugins` on the conversation GET, so the pill
  // can't reflect per-chat state there — hide it until the daemon supports it.
  const supportsPluginPill = useSupportsInchatPluginEdit();

  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);

  // Channel header tag derivation. Slack keeps its richer label (channel
  // vs DM, lazy name resolution); other channels fall back to the generic
  // binding name, then the channel's human label.
  const slackConversationDisplay = useSlackConversationDisplay({
    assistantId: assistantId ?? undefined,
    conversation: activeConversation,
    messages,
  });
  const channelHeaderChannelId = isChannelConversation(activeConversation)
    ? activeConversation?.originChannel ?? null
    : null;
  const channelHeaderLabel = useMemo(() => {
    if (!channelHeaderChannelId) return null;
    if (channelHeaderChannelId === "slack") {
      return slackConversationDisplay
        ? formatSlackConversationDisplayLabel(slackConversationDisplay)
        : getChannelLabel("slack");
    }
    return (
      getChannelBindingDisplayText(activeConversation?.channelBinding) ??
      getChannelLabel(channelHeaderChannelId)
    );
  }, [
    channelHeaderChannelId,
    slackConversationDisplay,
    activeConversation?.channelBinding,
  ]);

  // Deep link back to the conversation's source in the external channel.
  // Slack's display href comes first because it is richer — it folds in
  // message-level links from the transcript — and it also covers daemons
  // that predate the binding's channel-neutral `sourceLink`. Every other
  // channel goes through `sourceLink`, so a channel lights up here as soon
  // as its daemon-side binding-metadata builder emits one.
  const channelSourceLinkHref = channelHeaderChannelId
    ? slackConversationDisplay?.href ??
      getSlackLinkUrl(activeConversation?.channelBinding?.sourceLink) ??
      null
    : null;

  // Header supplements — chat-specific data for the conversation header menu
  const hasPersistedMessage = useMemo(
    () => messages.some((m) => m.id != null),
    [messages],
  );

  const headerSupplements = useMemo<ChatHeaderSupplements>(() => ({
    hasPersistedMessage,
    channelHeaderLabel,
    channelHeaderChannelId,
    onAnalyze: handleAnalyzeConversation,
    onForkConversation: handleForkConversationFromMenu,
    onOpenInNewWindow: handleOpenInNewWindow,
    onInspect: handleInspectConversation,
    onCopyConversation: messages.length > 0 ? handleCopyConversation : null,
    onRefresh,
  }), [
    hasPersistedMessage,
    channelHeaderLabel,
    channelHeaderChannelId,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    messages.length,
    onRefresh,
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

  const topBarRightContent = useMemo(() => {
    if (!activeConversation?.conversationId || !assistantId) return null;
    return (
      <>
        {channelSourceLinkHref ? (
          <ChannelSourceLinkPill
            href={channelSourceLinkHref}
            channelId={channelHeaderChannelId}
          />
        ) : null}
        <ConversationAssetsPill
          assistantId={assistantId}
          conversationId={activeConversation.conversationId}
          refreshKey={assetsRefreshKey}
          onOpenApp={handleOpenAppFromChat}
          onOpenDocument={handleOpenDocument}
        />
        {supportsPluginPill ? (
          <InChatPluginPill
            assistantId={assistantId}
            conversationId={activeConversation.conversationId}
          />
        ) : null}
      </>
    );
  }, [activeConversation?.conversationId, assistantId, assetsRefreshKey, handleOpenAppFromChat, handleOpenDocument, supportsPluginPill, channelSourceLinkHref, channelHeaderChannelId]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => { setTopBarRightSlot(null); };
  }, [topBarRightContent, setTopBarRightSlot]);

}
