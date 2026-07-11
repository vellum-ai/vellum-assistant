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
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { ContextMenu, PanelItem } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import {
  ConversationActionsMenu,
  ConversationActionsSheet,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import { useLongPress } from "@/hooks/use-long-press";
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
  if (
    !dragSection ||
    !ctx.canReorder ||
    !dragSiblings ||
    dragSiblings.length < 2
  ) {
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

  // Trailing (swipe left): Archive / Unarchive. Available for channel
  // conversations too — archive is an organizational action that doesn't write
  // to the source channel (matches the row menu, which keeps archive available
  // for read-only channel threads). Only Pin above is channel-excluded.
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
      ? (ctx.activeConversationProcessing ?? false)
      : (ctx.processingConversationIds?.has(conversationId) ?? false);
  const needsAttention =
    ctx.attentionConversationIds?.has(conversationId) ?? false;

  const menuProps = buildMenuProps(ctx, conversation);
  const select = onSelect ?? ctx.onSelect;

  // Touch: long-pressing the row opens the actions bottom sheet, matching the
  // trailing ellipsis (which already branches to a BottomSheet on mobile) and
  // the transcript message long-press pattern. Radix ContextMenu renders a
  // pointer-positioned popover on touch, which is the wrong surface on mobile.
  const [longPressOpen, setLongPressOpen] = useState(false);
  // After a long-press fires, the browser still emits a compatibility click on
  // touchend. Without suppression that click reaches PanelItem.onSelect and
  // navigates to the conversation *behind* the sheet. Mirror the transcript
  // long-press guard: set a flag on activation, swallow the next click in a
  // capture-phase handler, and clear it when the sheet closes (in case the
  // compat click never reaches this wrapper — e.g. routed to the sheet).
  const longPressFiredRef = useRef(false);
  const longPressHandlers = useLongPress(
    () => {
      longPressFiredRef.current = true;
      setLongPressOpen(true);
    },
    undefined,
    {
      // The row itself is the interactive target (PanelItem renders
      // `role="button"` for its `onSelect`), so the default interactive-target
      // skip would suppress the gesture entirely. Opt out of it and instead
      // skip only nested *real* controls — the trailing actions ellipsis and
      // the swipe-reveal action buttons (Pin/Archive) are `<button>`/`<a>`
      // elements that own their own taps. The row `role="button"` div is not a
      // real `<button>`, so this selector arms on the row but not those.
      ignoreInteractiveTarget: true,
      shouldSkip: (target) => Boolean(target?.closest("button, a")),
    },
  );
  const handleLongPressOpenChange = useCallback((open: boolean) => {
    setLongPressOpen(open);
    if (!open) {
      longPressFiredRef.current = false;
    }
  }, []);
  const handleClickCapture = useCallback((event: ReactMouseEvent) => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const status = {
    isProcessing,
    needsAttention,
    hasUnread: conversation.hasUnseenLatestAssistantMessage === true,
  };
  const dragProps = buildDragProps(
    ctx,
    conversation,
    dragSection,
    dragSiblings,
  );
  const { leadingActions, trailingActions } = buildSwipeActions(
    ctx,
    conversation,
  );

  const isTouch = isPointerCoarse();

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
        badge={
          hasThreadStatus(status) ? (
            <ThreadStatusIndicator {...status} />
          ) : undefined
        }
        trailingAction={<ConversationActionsMenu {...menuProps} />}
        {...dragProps}
        className={cn(
          "h-[30px] p-[6px] text-[var(--content-default)]",
          dragProps.className,
        )}
      />
    </SwipeActionReveal>
  );

  // Touch: replace the right-click ContextMenu with a long-press → bottom sheet.
  // The long-press touch handlers wrap the row; the gesture arms on the row
  // itself (see `ignoreInteractiveTarget` above) and its `shouldSkip` avoids
  // the nested ellipsis / swipe buttons, so they don't double-trigger. The
  // wrapper adds no layout box (contents display) so the swipe-to-reveal
  // geometry is unaffected. Gated on `withContextMenu` so the rail flyout —
  // which opts out of the row menu on desktop — stays consistent on touch (its
  // rows are reached via the trailing ellipsis).
  if (isTouch && withContextMenu) {
    return (
      <div
        className="contents"
        onClickCapture={handleClickCapture}
        onTouchStart={longPressHandlers.onTouchStart}
        onTouchMove={longPressHandlers.onTouchMove}
        onTouchEnd={longPressHandlers.onTouchEnd}
        onTouchCancel={longPressHandlers.onTouchCancel}
      >
        {panelItem}
        <ConversationActionsSheet
          {...menuProps}
          open={longPressOpen}
          onOpenChange={handleLongPressOpenChange}
        />
      </div>
    );
  }

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
