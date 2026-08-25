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
import { useShowsHoverAffordance } from "@/hooks/use-hover-affordance";
import {
  ConversationActionsMenu,
  ConversationActionsSheet,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import { useTranslation } from "@/i18n";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import {
  hasThreadStatus,
  ThreadStatusIndicator,
} from "@/domains/chat/components/thread-status-indicator";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { copyIdToClipboard } from "@/domains/chat/utils/copy-id-to-clipboard";
import {
  buildMoveToGroupTargets,
  isInCustomGroup,
} from "@/domains/chat/utils/group-conversations";
import type { Conversation } from "@/types/conversation-types";
import {
  canMarkRead,
  canMarkUnread,
  isConversationPinned,
} from "@/utils/conversation-predicates";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";

import {
  type ConversationListContextValue,
  useConversationListContext,
} from "./conversation-list-context";

export interface ConversationRowProps {
  conversation: Conversation;
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
    onDelete:
      ctx.onDelete && hasId && !conversation.draft
        ? () => ctx.onDelete?.(conversation)
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
    // Only build the targets list when the move action is wired, so a surface
    // that doesn't provide it skips the per-row allocation.
    moveToGroups: ctx.onMoveToGroup
      ? buildMoveToGroupTargets(conversation, ctx.conversationGroups)
      : undefined,
    onMoveToGroup: ctx.onMoveToGroup
      ? (groupId) => ctx.onMoveToGroup?.(conversation, groupId)
      : undefined,
    onCreateGroupInto: ctx.onCreateGroupInto
      ? () => ctx.onCreateGroupInto?.(conversation)
      : undefined,
    onRemoveFromGroup:
      ctx.onRemoveFromGroup && isInCustomGroup(conversation)
        ? () => ctx.onRemoveFromGroup?.(conversation)
        : undefined,
    onOpenInNewWindow:
      ctx.showInternalActions && ctx.onOpenInNewWindow && hasId
        ? () => ctx.onOpenInNewWindow?.(conversation)
        : undefined,
    onShareFeedback: ctx.onShareFeedback,
    onInspect:
      ctx.onInspect && hasId ? () => ctx.onInspect?.(conversation) : undefined,
    onCopyConversationId:
      ctx.showInternalActions && hasId
        ? () => copyIdToClipboard(conversation.conversationId!, "conversation")
        : undefined,
  };
}

/**
 * The trailing actions ellipsis and the swipe-reveal buttons are real
 * `<button>` / `<a>` elements that own their own taps. The row itself is only
 * a `role="button"` div, so this arms on the row but not on those.
 */
const skipNestedControls = (target: Element | null) =>
  Boolean(target?.closest("button, a"));

/**
 * Builds the swipe-to-reveal action arrays for a conversation row.
 *
 * - Swipe left (trailing) → Archive / Unarchive
 * - Swipe right (leading) → Pin / Unpin
 *
 * Returns empty arrays for channel conversations (read-only, so no pin/archive
 * actions are available). Actions without a callback in the context are
 * omitted, so the swipe surface gracefully degrades when the host list doesn't
 * provide every action. Whether a swipe is the input at all is
 * `SwipeActionReveal`'s question, which passes through untouched where it isn't.
 */
function buildSwipeActions(
  ctx: ConversationListContextValue,
  conversation: Conversation,
): { leadingActions: SwipeAction[]; trailingActions: SwipeAction[] } {
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
  withContextMenu = true,
  marquee = true,
  onSelect,
}: ConversationRowProps) {
  const ctx = useConversationListContext();
  const { conversationId } = conversation;
  const { t } = useTranslation("chat");

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
  const longPress = useLongPressSheet({ shouldSkip: skipNestedControls });

  const status = {
    isProcessing,
    needsAttention,
    hasUnread: conversation.hasUnseenLatestAssistantMessage === true,
  };
  const { leadingActions, trailingActions } = buildSwipeActions(
    ctx,
    conversation,
  );

  const isTouch = isPointerCoarse();
  // The swipe and the long-press sheet are the paths that replace the inline
  // ellipsis, and both are armed by a coarse pointer, so a device that has
  // neither hover nor a coarse pointer (a hoverless stylus) keeps the ellipsis:
  // right-click alone is not a path ordinary tapping or a screen reader finds.
  const showsEllipsis = useShowsHoverAffordance(withContextMenu && isTouch);

  const panelItem = (
    <SwipeActionReveal
      leadingActions={leadingActions}
      trailingActions={trailingActions}
    >
      <PanelItem
        label={conversation.title ?? t("conversationRow.untitled")}
        marqueeOnHover={marquee}
        active={conversationId === ctx.activeConversationId}
        onSelect={() => select(conversationId)}
        badge={
          hasThreadStatus(status) ? (
            <ThreadStatusIndicator {...status} />
          ) : undefined
        }
        badgeBare
        trailingAction={
          showsEllipsis ? <ConversationActionsMenu {...menuProps} /> : undefined
        }
        className={cn(
          // `!` forces this over PanelItem's own max-md:py-3: cross-package
          // Tailwind generation order doesn't reliably favor a plain
          // (unmarked) override here.
          "p-[6px] max-md:p-2! text-[var(--content-default)]",
          // A row in the drawer stands at the same height as the pills above
          // it, which is taller than a row in the rail. Restated under
          // `max-md` for the same reason the padding above is: PanelItem's own
          // `max-md:h-auto` is a variant, so an unprefixed height never
          // reaches it at a touch viewport.
          // The wash belongs to the row rather than the panel: declared on the
          // menu it would reach every active PanelItem in the drawer, and a
          // tinted pill that publishes `--panel-item-bg` and no active value
          // of its own would lose its colour to it.
          ctx.overlayCards
            ? "min-h-[var(--side-menu-tile-size)] [--panel-item-active:var(--surface-hover)]"
            : "h-[30px]",
        )}
      />
    </SwipeActionReveal>
  );

  // Touch: replace the right-click ContextMenu with a long-press → bottom sheet.
  // The gesture wrapper adds no layout box (`display: contents`) so the
  // swipe-to-reveal geometry is unaffected, and the sheet is its sibling — see
  // {@link useLongPressSheet}. Gated on `withContextMenu` so the rail flyout,
  // which opts out of the row menu on desktop, stays consistent on touch.
  if (isTouch && withContextMenu) {
    return (
      <>
        <div {...longPress.wrapperProps}>{panelItem}</div>
        <ConversationActionsSheet
          {...menuProps}
          open={longPress.open}
          onOpenChange={longPress.onOpenChange}
        />
      </>
    );
  }

  if (!withContextMenu) {
    return panelItem;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        {renderConversationMenuItems({
          Primitive: ContextMenu,
          t,
          ...menuProps,
        })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
