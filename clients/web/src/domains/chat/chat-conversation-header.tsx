import { Button } from "@vellumai/design-library";
import { ChevronDown } from "lucide-react";

import type { ChatHeaderSupplements } from "@/components/layout/chat-layout-slots-store";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import {
  buildMoveToGroupTargets,
  isInCustomGroup,
} from "@/domains/chat/utils/group-conversations";
import { ChannelIcon, getOpenInChannelLabel } from "@/utils/channel-presentation";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";

interface ChatConversationHeaderProps {
  assistantId: string | null;
  activeConversation: Conversation | null;
  headerSupplements: ChatHeaderSupplements | null;
  showLlmInspector: boolean;
  conversationGroups?: ConversationGroup[];
  onArchive: (c: Conversation) => void;
  onUnarchive: (c: Conversation) => void;
  onMarkUnread: (c: Conversation) => void;
  onMarkRead: (c: Conversation) => void;
  onPinToggle: (c: Conversation) => void;
  onRename: (c: Conversation) => void;
  onMoveToGroup: (c: Conversation, groupId: string) => void;
  onCreateGroupInto: (c: Conversation) => void;
  onRemoveFromGroup: (c: Conversation) => void;
}

export function ChatConversationHeader({
  assistantId,
  activeConversation,
  headerSupplements,
  showLlmInspector,
  conversationGroups,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onMarkRead,
  onPinToggle,
  onRename,
  onMoveToGroup,
  onCreateGroupInto,
  onRemoveFromGroup,
}: ChatConversationHeaderProps) {
  if (!activeConversation) {
    if (!assistantId) {return null;}
    return (
      <span className="text-sm font-medium text-[var(--content-default)]">
        New Chat
      </span>
    );
  }

  const isReadonly = isChannelConversation(activeConversation);
  const isPinned = activeConversation.isPinned || activeConversation.groupId === "system:pinned";
  const isArchived = activeConversation.archivedAt != null;

  // Channel tag — icon + label identifying the originating external
  // channel (Slack, Telegram, …). Slack uses its brand glyph; other
  // channels use a neutral Lucide icon from the presentation registry.
  const channelHeaderLabel = headerSupplements?.channelHeaderLabel ?? null;
  const channelHeaderChannelId = headerSupplements?.channelHeaderChannelId ?? null;
  const channelSourceLinkHref = headerSupplements?.channelSourceLinkHref ?? null;
  const channelSourceLink = channelSourceLinkHref
    ? {
        href: channelSourceLinkHref,
        label: getOpenInChannelLabel(channelHeaderChannelId),
      }
    : null;

  return (
    <ConversationActionsMenu
      variant="header"
      channelSourceLink={channelSourceLink}
      isPinned={isPinned}
      isArchived={isArchived}
      isReadonly={isReadonly}
      onPinToggle={() => onPinToggle(activeConversation)}
      onRename={() => onRename(activeConversation)}
      moveToGroups={buildMoveToGroupTargets(activeConversation, conversationGroups)}
      onMoveToGroup={(groupId) => onMoveToGroup(activeConversation, groupId)}
      onCreateGroupInto={() => onCreateGroupInto(activeConversation)}
      onRemoveFromGroup={
        isInCustomGroup(activeConversation)
          ? () => onRemoveFromGroup(activeConversation)
          : undefined
      }
      onArchive={() => onArchive(activeConversation)}
      onUnarchive={() => onUnarchive(activeConversation)}
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
            {channelHeaderLabel ? (
              channelHeaderChannelId === "slack" ? (
                <img
                  src="/images/integrations/slack.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                />
              ) : (
                <ChannelIcon
                  channelId={channelHeaderChannelId}
                  className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
                />
              )
            ) : null}
            <span className="min-w-0 max-w-[220px] truncate leading-6">
              {isArchived && (
                <span className="mr-1 text-[var(--content-tertiary)]">
                  [Archived]
                </span>
              )}
              {activeConversation.title ?? "Untitled"}
            </span>
            {channelHeaderLabel ? (
              <span className="hidden max-w-[160px] shrink truncate leading-6 text-[var(--content-tertiary)] sm:inline">
                ({channelHeaderLabel})
              </span>
            ) : null}
          </span>
        </Button>
      }
    />
  );
}
