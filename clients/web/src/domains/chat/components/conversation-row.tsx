/**
 * A single conversation row in the assistant sidebar: a pin/processing
 * toggle, the title, an actions menu, an optional right-click context
 * menu, and optional drag-reorder. Action callbacks, active/processing
 * state, and the drag controller come from
 * {@link useConversationListContext}.
 *
 * Rendered in every list surface — Pinned, Recents, channel sections,
 * custom groups, and the collapsed-rail flyout. The flyout passes
 * `withContextMenu={false}` (no right-click menu) and `marquee={false}`.
 */

import { ContextMenu, PanelItem } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import { ThreadPinToggle } from "@/domains/chat/components/thread-pin-toggle";
import type { DragReorderItemProps } from "@/domains/chat/hooks/use-drag-reorder";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isConversationPinned } from "@/domains/chat/utils/group-conversations";
import type { Conversation } from "@/types/conversation-types";
import { canMarkRead, canMarkUnread } from "@/utils/conversation-predicates";

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
    onAnalyze:
      ctx.onAnalyze && hasId && !isChannel
        ? () => ctx.onAnalyze?.(conversation)
        : undefined,
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

  const panelItem = (
    <PanelItem
      leadingSlot={
        <ThreadPinToggle
          conversation={conversation}
          isProcessing={isProcessing}
          needsAttention={needsAttention}
          onPinToggle={ctx.onPin ? () => ctx.onPin?.(conversation) : undefined}
        />
      }
      label={conversation.title ?? "Untitled"}
      marqueeOnHover={marquee}
      active={conversationId === ctx.activeConversationId}
      onSelect={() => select(conversationId)}
      trailingAction={<ConversationActionsMenu {...menuProps} />}
      {...buildDragProps(ctx, conversation, dragSection, dragSiblings)}
    />
  );

  if (!withContextMenu) return panelItem;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        {renderConversationMenuItems({ Primitive: ContextMenu, ...menuProps })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
