import { Button } from "@vellumai/design-library";
import { ChevronDown } from "lucide-react";

import type { ChatHeaderSupplements } from "@/components/layout/chat-layout-slots-store";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import type { Conversation } from "@/types/conversation-types";

interface ChatConversationHeaderProps {
  assistantId: string | null;
  activeConversation: Conversation | null;
  headerSupplements: ChatHeaderSupplements | null;
  showLlmInspector: boolean;
  onArchive: (c: Conversation) => void;
  onUnarchive: (c: Conversation) => void;
  onMarkUnread: (c: Conversation) => void;
  onMarkRead: (c: Conversation) => void;
  onPinToggle: (c: Conversation) => void;
  onRename: (c: Conversation) => void;
}

export function ChatConversationHeader({
  assistantId,
  activeConversation,
  headerSupplements,
  showLlmInspector,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onMarkRead,
  onPinToggle,
  onRename,
}: ChatConversationHeaderProps) {
  if (!activeConversation) {
    if (!assistantId) return null;
    return (
      <span className="text-sm font-medium text-[var(--content-default)]">
        New conversation
      </span>
    );
  }

  const isReadonly = isChannelConversation(activeConversation);
  const isPinned = activeConversation.isPinned || activeConversation.groupId === "system:pinned";
  const isArchived = activeConversation.archivedAt != null;

  return (
    <ConversationActionsMenu
      variant="header"
      isPinned={isPinned}
      isArchived={isArchived}
      isReadonly={isReadonly}
      onPinToggle={() => onPinToggle(activeConversation)}
      onRename={() => onRename(activeConversation)}
      onArchive={() => onArchive(activeConversation)}
      onUnarchive={() => onUnarchive(activeConversation)}
      onAnalyze={
        !isReadonly && headerSupplements?.onAnalyze && activeConversation.conversationId
          ? () => headerSupplements.onAnalyze!(activeConversation)
          : undefined
      }
      onForkConversation={
        !isReadonly && headerSupplements?.hasPersistedMessage && headerSupplements?.onForkConversation
          ? headerSupplements.onForkConversation
          : undefined
      }
      onOpenInNewWindow={
        headerSupplements?.onOpenInNewWindow && activeConversation.conversationId
          ? () => headerSupplements.onOpenInNewWindow!(activeConversation)
          : undefined
      }
      onInspect={
        showLlmInspector && headerSupplements?.onInspect && activeConversation.conversationId
          ? () => headerSupplements.onInspect!(activeConversation)
          : undefined
      }
      onCopyConversation={headerSupplements?.onCopyConversation ?? undefined}
      onRefresh={
        headerSupplements?.onRefresh && activeConversation.conversationId != null
          ? headerSupplements.onRefresh
          : undefined
      }
      onMarkUnread={
        !isReadonly && activeConversation.hasUnseenLatestAssistantMessage === false
          ? () => onMarkUnread(activeConversation)
          : undefined
      }
      onMarkRead={
        activeConversation.hasUnseenLatestAssistantMessage
          ? () => onMarkRead(activeConversation)
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
            {headerSupplements?.slackHeaderLabel ? (
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
            {headerSupplements?.slackHeaderLabel ? (
              <span className="hidden max-w-[160px] shrink truncate leading-6 text-[var(--content-tertiary)] sm:inline">
                ({headerSupplements.slackHeaderLabel})
              </span>
            ) : null}
          </span>
        </Button>
      }
    />
  );
}
