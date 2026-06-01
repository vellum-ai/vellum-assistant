/**
 * Constructs and registers topBarCenter / topBarRightSlot content for the
 * chat route's layout header. Owns the Slack display label, conversation
 * actions menu trigger, and the assets pill.
 *
 * Extracted from ChatPage to reduce its orchestration surface.
 */

import { type ReactNode, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@vellum/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
import {
  formatSlackConversationDisplayLabel,
} from "@/domains/chat/utils/slack-conversation-display";
import { useSlackConversationDisplay } from "@/domains/chat/hooks/use-slack-conversation-display";
import { buildMoveToGroupTargets } from "@/domains/chat/utils/group-conversations";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationActionCallbacks {
  handleTogglePinConversation: (c: Conversation) => void;
  handleRenameConversation: (c: Conversation) => void;
  handleArchiveConversation: (c: Conversation) => void;
  handleUnarchiveConversation: (c: Conversation) => void;
  handleAnalyzeConversation: (c: Conversation) => void;
  handleForkConversationFromMenu: () => void;
  handleOpenInNewWindow: (c: Conversation) => void;
  handleInspectConversation: (c: Conversation) => void;
  handleCopyConversation: () => void;
  handleMoveToGroup: (c: Conversation, groupId: string) => void;
  handleRemoveFromGroup: (c: Conversation) => void;
  handleMarkConversationUnread: (c: Conversation) => void;
  handleMarkConversationRead: (c: Conversation) => void;
}

interface UseChatHeaderSlotsParams extends ConversationActionCallbacks {
  assistantId: string | null;
  activeConversation: Conversation | undefined;
  isChannelReadonly: boolean;
  messages: DisplayMessage[];
  conversationGroups: ConversationGroup[];
  showLlmInspector: boolean;
  refreshLatestMessages: () => void;
  assetsRefreshKey: number;
  handleOpenApp: (appId: string) => void;
  handleOpenDocument: (surfaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatHeaderSlots({
  assistantId,
  activeConversation,
  isChannelReadonly,
  messages,
  conversationGroups,
  showLlmInspector,
  refreshLatestMessages,
  assetsRefreshKey,
  handleOpenApp,
  handleOpenDocument,
  handleTogglePinConversation,
  handleRenameConversation,
  handleArchiveConversation,
  handleUnarchiveConversation,
  handleAnalyzeConversation,
  handleForkConversationFromMenu,
  handleOpenInNewWindow,
  handleInspectConversation,
  handleCopyConversation,
  handleMoveToGroup,
  handleRemoveFromGroup,
  handleMarkConversationUnread,
  handleMarkConversationRead,
}: UseChatHeaderSlotsParams): void {
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const setTopBarRightSlot = useChatLayoutSlotsStore.use.setTopBarRightSlot();

  const hasPersistedMessage = useMemo(
    () => messages.some((m) => m.id != null),
    [messages],
  );

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

  // -------------------------------------------------------------------------
  // Center slot — conversation title + actions menu
  // -------------------------------------------------------------------------
  const topBarCenterContent = useMemo<ReactNode>(() => {
    if (!activeConversation) {
      return assistantId ? (
        <span className="text-sm font-medium text-[var(--content-default)]">
          New conversation
        </span>
      ) : null;
    }
    const moveToGroups = buildMoveToGroupTargets(activeConversation, conversationGroups);
    const isPinned = activeConversation.isPinned || activeConversation.groupId === "system:pinned";
    const isArchived = activeConversation.archivedAt != null;
    return (
      <ConversationActionsMenu
        variant="header"
        isPinned={isPinned}
        isArchived={isArchived}
        isReadonly={isChannelReadonly}
        onPinToggle={() => handleTogglePinConversation(activeConversation)}
        onRename={() => handleRenameConversation(activeConversation)}
        onArchive={() => handleArchiveConversation(activeConversation)}
        onUnarchive={() => handleUnarchiveConversation(activeConversation)}
        onAnalyze={
          !isChannelReadonly && activeConversation.conversationId
            ? () => handleAnalyzeConversation(activeConversation)
            : undefined
        }
        onForkConversation={
          !isChannelReadonly && hasPersistedMessage
            ? handleForkConversationFromMenu
            : undefined
        }
        onOpenInNewWindow={
          activeConversation.conversationId
            ? () => handleOpenInNewWindow(activeConversation)
            : undefined
        }
        onInspect={
          showLlmInspector && activeConversation.conversationId
            ? () => handleInspectConversation(activeConversation)
            : undefined
        }
        onCopyConversation={
          messages.length > 0
            ? handleCopyConversation
            : undefined
        }
        onRefresh={
          activeConversation.conversationId != null
            ? refreshLatestMessages
            : undefined
        }
        moveToGroups={moveToGroups}
        onMoveToGroup={(groupId) => handleMoveToGroup(activeConversation, groupId)}
        onRemoveFromGroup={
          activeConversation.groupId && !activeConversation.groupId.startsWith("system:")
            ? () => handleRemoveFromGroup(activeConversation)
            : undefined
        }
        onMarkUnread={
          !isChannelReadonly && activeConversation.hasUnseenLatestAssistantMessage === false
            ? () => handleMarkConversationUnread(activeConversation)
            : undefined
        }
        onMarkRead={
          activeConversation.hasUnseenLatestAssistantMessage
            ? () => handleMarkConversationRead(activeConversation)
            : undefined
        }
        side="bottom"
        align="center"
        sideOffset={8}
        trigger={
          <Button
            variant="ghost"
            rightIcon={<ChevronDown />}
            aria-haspopup="menu"
            className="min-w-0"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {slackHeaderLabel ? (
                <img
                  src="/images/integrations/slack.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                />
              ) : null}
              <span className="min-w-0 max-w-[220px] truncate leading-6">
                {isArchived && (
                  <span className="mr-1 text-[var(--content-tertiary)]">
                    [Archived]
                  </span>
                )}
                {activeConversation.title ?? "Untitled"}
              </span>
              {slackHeaderLabel ? (
                <span className="hidden max-w-[160px] shrink truncate leading-6 text-[var(--content-tertiary)] sm:inline">
                  ({slackHeaderLabel})
                </span>
              ) : null}
            </span>
          </Button>
        }
      />
    );
  }, [
    activeConversation,
    assistantId,
    isChannelReadonly,
    slackHeaderLabel,
    conversationGroups,
    handleTogglePinConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    showLlmInspector,
    handleCopyConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    hasPersistedMessage,
    messages.length,
    refreshLatestMessages,
  ]);

  useEffect(() => {
    setTopBarCenter(topBarCenterContent);
    return () => { setTopBarCenter(null); };
  }, [topBarCenterContent, setTopBarCenter]);

  // -------------------------------------------------------------------------
  // Right slot — conversation assets pill
  // -------------------------------------------------------------------------
  const topBarRightContent = useMemo<ReactNode>(() => {
    if (!activeConversation?.conversationId || !assistantId) return null;
    return (
      <ConversationAssetsPill
        assistantId={assistantId}
        conversationId={activeConversation.conversationId}
        refreshKey={assetsRefreshKey}
        onOpenApp={handleOpenApp}
        onOpenDocument={handleOpenDocument}
      />
    );
  }, [activeConversation?.conversationId, assistantId, assetsRefreshKey, handleOpenApp, handleOpenDocument]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => { setTopBarRightSlot(null); };
  }, [topBarRightContent, setTopBarRightSlot]);
}
