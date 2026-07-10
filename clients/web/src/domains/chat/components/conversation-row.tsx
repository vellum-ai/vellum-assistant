/**
 * A single conversation row in the assistant sidebar: the title, a
 * trailing status indicator (attention / processing / unread), an
 * actions menu, an optional right-click context menu, and optional
 * drag-reorder. Pin/unpin lives in the actions and context menus.
 * Action callbacks, active/processing state, and the drag controller
 * come from {@link useConversationListContext}.
 *
 * Rendered in every list surface — Pinned, Recents, channel sections,
 * custom groups, and the collapsed-rail flyout. The flyout passes
 * `withContextMenu={false}` (no right-click menu) and `marquee={false}`.
 */

import { Archive, ArchiveRestore, Pin, PinOff } from "lucide-react";

import { ContextMenu, PanelItem } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import {
  hasThreadStatus,
  ThreadStatusIndicator,
} from "@/domains/chat/components/thread-status-indicator";
import type { DragReorderItemProps } from "@/domains/chat/hooks/use-drag-reorder";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isConversationPinned } from "@/domains/chat/utils/group-conversations";
import type { Conversation } from "@/types/conversation-types";
import { canMarkRead, canMarkUnread } from "@/utils/conversation-predicates";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";

import {
  type ConversationListContextValue,
  useConversationListContext,
} from "./conversation-list-context";

export interface ConversationRowProps {
  conversation: Conversation;
  /**
   * Drag-reorder section key. Omit for non-reorderable lists (Recents,
   * channel sections) — only Pinned and custom groups reorder.
   */
  dragSection?: string;
  /** The section's full ordered list, for drag math. Defaults to nothing. */
  dragSiblings?: Conversation[];
  /** Wrap in a right-click context menu. Default true; false in the rail flyout. */
  withContextMenu?: boolean;
  /** Marquee the title on hover. Default true; false in the rail flyout. */
  marquee?: boolean;
  /** Override the select handler (the rail flyout also closes the popover). */
  onSelect?: (conversationId: string) => void;
}

export function buildMenuProps(
  ctx: ConversationListContextValue,
  conversation: Conversation,
): ConversationMenuItemsProps {
  const isChannel = isChannelConversation(conversation);
  const hasId = conversation.conversationId != null;
  return {
    isPinned: isConversationPinned(conversation),
    isArchived: conversation.archivedAt != null,
    isReadonly: isChannel,
    onPinToggle: ctx.onPin ? () => ctx.onPin?.(conversation) : undefined,
    onRename: ctx.onRename ? () => ctx.onRename?.(conversation) : undefined,
    onArchive: ctx.onArchive ? () => ctx.onArchive?.(conversation) : undefined,
    onUnarchive: ctx.onUnarchive
      ? () => ctx.onUnarchive?.(conversation)
      : undefined,
    onMarkRead:
      ctx.onMarkRead && canMarkRead(conversation)
        ? () => ctx.onMarkRead?.(conversation)
        : undefined,
    onMarkUnread:
      ctx.onMarkUnread && !canMarkRead(conversation)
        ? () => ctx.onMarkUnread?.(conversation)
        : undefined,
    isMarkUnreadDisabled: !canMarkUnread(conversation),
    onOpenInNewWindow:
      ctx.onOpenInNewWindow && hasId
        ? () => ctx.onOpenInNewWindow?.(conversation)
        : undefined,
    onShareFeedback: ctx.onShareFeedback,
    onInspect:
      ctx.onInspect && hasId ? () => ctx.onInspect?.(conversation) : undefined,
  };
}

export function buildDragProps(
  ctx: ConversationListContextValue,
  conversation: Conversation,
  dragSection: string | undefined,
  dragSiblings: Conversation[] | undefined,
): Partial<DragReorderItemProps> & { className?: string } {
  if (!dragSection || !ctx.canReorder || !dragSiblings || dragSiblings.length < 2) {
    return {};
  }
  const { draggingId, dropIndicator } = ctx.dragReorder;
  const edge =
    dropIndicator?.section === dragSection &&
    dropIndicator.itemId === conversation.conversationId
      ? dropIndicator.edge
      : null;
  return {
    ...ctx.dragReorder.getItemProps(dragSection, dragSiblings, conversation),
    className: cn(
      draggingId === conversation.conversationId && "opacity-50",
      edge === "before" && "shadow-[inset_0_2px_0_0_var(--primary-base)]",
      edge === "after" && "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
    ),
  };
}

/**
 * Builds the swipe-to-reveal action arrays for a conversation row.
 *
 * - Swipe left (trailing) → Archive / Unarchive
 * - Swipe right (leading) → Pin / Unpin
 *
 * Returns empty arrays on desktop (fine pointer) or for channel conversations
 * (read-only — no pin/archive actions available). Actions without a callback
 * in the context are omitted, so the swipe surface gracefully degrades when
 * the host list doesn't provide every action.
 */
export function buildSwipeActions(
  ctx: ConversationListContextValue,
  conversation: Conversation,
): { leadingActions: SwipeAction[]; trailingActions: SwipeAction[] } {
  if (!isPointerCoarse()) {
    return { leadingActions: [], trailingActions: [] };
  }
  const isChannel = isChannelConversation(conversation);

  const leadingActions: SwipeAction[] = [];
  const trailingActions: SwipeAction[] = [];

  // Leading (swipe right): Pin / Unpin
  if (!isChannel && ctx.onPin) {
    const isPinned = isConversationPinned(conversation);
    leadingActions.push({
      id: "pin",
      label: isPinned ? "Unpin" : "Pin",
      icon: isPinned ? PinOff : Pin,
      onSelect: () => ctx.onPin?.(conversation),
    });
  }

  // Trailing (swipe left): Archive / Unarchive
  if (!isChannel) {
    const isArchived = conversation.archivedAt != null;
    if (isArchived && ctx.onUnarchive) {
      trailingActions.push({
        id: "unarchive",
        label: "Unarchive",
        icon: ArchiveRestore,
        onSelect: () => ctx.onUnarchive?.(conversation),
      });
    } else if (!isArchived && ctx.onArchive) {
      trailingActions.push({
        id: "archive",
        label: "Archive",
        icon: Archive,
        variant: "destructive",
        onSelect: () => ctx.onArchive?.(conversation),
      });
    }
  }

  return { leadingActions, trailingActions };
}

export function ConversationRow({
  conversation,
  dragSection,
  dragSiblings,
  withContextMenu = true,
  marquee = true,
  onSelect,
}: ConversationRowProps) {
  const ctx = useConversationListContext();
  const { conversationId } = conversation;

  const isProcessing =
    conversationId === ctx.activeConversationId
      ? ctx.activeConversationProcessing ?? false
      : ctx.processingConversationIds?.has(conversationId) ?? false;
  const needsAttention =
    ctx.attentionConversationIds?.has(conversationId) ?? false;

  const menuProps = buildMenuProps(ctx, conversation);
  const select = onSelect ?? ctx.onSelect;

  const status = {
    isProcessing,
    needsAttention,
    hasUnread: conversation.hasUnseenLatestAssistantMessage === true,
  };
  const dragProps = buildDragProps(ctx, conversation, dragSection, dragSiblings);
  const { leadingActions, trailingActions } = buildSwipeActions(ctx, conversation);

  const panelItem = (
    <SwipeActionReveal
      leadingActions={leadingActions}
      trailingActions={trailingActions}
    >
      <PanelItem
        label={conversation.title ?? "Untitled"}
        marqueeOnHover={marquee}
        active={conversationId === ctx.activeConversationId}
        onSelect={() => select(conversationId)}
        badge={hasThreadStatus(status) ? <ThreadStatusIndicator {...status} /> : undefined}
        trailingAction={<ConversationActionsMenu {...menuProps} />}
        {...dragProps}
        className={cn(
          "h-[30px] p-[6px] text-[var(--content-default)]",
          dragProps.className,
        )}
      />
    </SwipeActionReveal>
  );

  if (!withContextMenu) {
    return panelItem;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        {renderConversationMenuItems({ Primitive: ContextMenu, ...menuProps })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
