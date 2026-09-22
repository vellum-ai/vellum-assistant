/**
 * A single conversation row in the assistant sidebar: the title, a
 * trailing status indicator (attention / processing / unread), one
 * trailing control, an optional right-click context menu, and optional
 * drag-reorder. Action callbacks, active/processing state, and the drag
 * controller come from {@link useConversationListContext}.
 *
 * Which trailing control it is, is the `sidebar-done` flag's answer. Off, it
 * is the actions "…", and pin/unpin lives in that menu and in the context
 * menu. On, it is a Done check: the row's one command is "I am finished with
 * this", and every other action is on the right-click menu and the chat
 * header's title dropdown. Both draw in the same box, so the row's geometry
 * does not depend on the flag.
 *
 * Rendered in every list surface — Pinned, Recents, channel sections,
 * custom groups, and the collapsed-rail flyout. The flyout passes
 * `withContextMenu={false}` (no right-click menu) and `marquee={false}`.
 */

import { Check, Pin, PinOff } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { useCallback, useEffect, useRef, useState } from "react";

import { ContextMenu, PanelItem, Tooltip } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { useShowsHoverAffordance } from "@/hooks/use-hover-affordance";
import {
  ConversationActionsMenu,
  ConversationActionsSheet,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import { useSectionDoneFlash } from "@/domains/chat/components/section-done-flash";
import {
  useConversationDoneLabels,
  useSidebarDoneEnabled,
  type ConversationDoneLabels,
} from "@/utils/done-labels";
import {
  ROW_TRAILING_CONTROL_CLASSES,
  ROW_TRAILING_GLYPH_CLASSES,
} from "@/domains/chat/utils/row-trailing-control";
import { useTranslation, type TFunction } from "@/i18n";
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
import { useDisplayConversationTitle } from "@/utils/conversation-title";
import { isPointerCoarse } from "@/utils/pointer";
import { useConversationMenuShortcuts } from "@/domains/chat/hooks/use-conversation-menu-shortcuts";
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
  /**
   * Whether this row may play the collapse-and-fade under `sidebar-done`.
   * The list passes `false` for a windowed one: virtuoso owns the geometry
   * of a row it is recycling, so a row animating its own height there fights
   * the measurement rather than reading as the row leaving.
   */
  animateDone?: boolean;
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
 *
 * Exported for the other conversation-row surfaces (the Old chats page), so
 * every long-press sheet over a conversation row arms on the same targets.
 * Module scope keeps the handlers `useLongPressSheet` returns stable.
 */
export const skipNestedControls = (target: Element | null) =>
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
  t: TFunction<"chat">,
  doneLabels: ConversationDoneLabels,
): { leadingActions: SwipeAction[]; trailingActions: SwipeAction[] } {
  const isChannel = isChannelConversation(conversation);

  const leadingActions: SwipeAction[] = [];
  const trailingActions: SwipeAction[] = [];

  // Leading (swipe right): Pin / Unpin
  if (!isChannel && ctx.onPin) {
    const isPinned = isConversationPinned(conversation);
    leadingActions.push({
      id: "pin",
      label: isPinned
        ? t("conversationActions.unpin")
        : t("conversationActions.pin"),
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
      label: doneLabels.unarchive,
      icon: doneLabels.unarchiveIcon,
      onSelect: () => ctx.onUnarchive?.(conversation),
    });
  } else if (!isArchived && ctx.onArchive) {
    trailingActions.push({
      id: "archive",
      label: doneLabels.swipeArchive,
      icon: doneLabels.archiveIcon,
      variant: "destructive",
      onSelect: () => ctx.onArchive?.(conversation),
    });
  }

  return { leadingActions, trailingActions };
}

/**
 * How long the row takes to collapse out of the list once it is marked done.
 * Short enough to read as the row leaving rather than as a wait for it.
 */
const DONE_EXIT_MS = 180;

/**
 * The row's own box, animatable. `SwipeActionReveal` forwards its ref and
 * takes `style`, which is all motion needs to drive the element a list
 * already lays out, so the collapse costs no wrapper and the rows stand
 * exactly where they stand with the flag off.
 */
const MotionSwipeActionReveal = motion.create(SwipeActionReveal);

export function ConversationRow({
  conversation,
  withContextMenu = true,
  marquee = true,
  onSelect,
  animateDone = false,
}: ConversationRowProps) {
  const ctx = useConversationListContext();
  const { conversationId } = conversation;
  const { t } = useTranslation("chat");
  const displayTitle = useDisplayConversationTitle();
  const sidebarDone = useSidebarDoneEnabled();
  const doneLabels = useConversationDoneLabels();
  const { flash } = useSectionDoneFlash();
  const reduceMotion = useReducedMotion();
  const [leaving, setLeaving] = useState(false);

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
    t,
    doneLabels,
  );

  const isTouch = isPointerCoarse();
  // The bound commands act on the active conversation, so only that row's
  // menu may advertise them.
  const isActiveConversation = conversationId === ctx.activeConversationId;
  const shortcuts = useConversationMenuShortcuts(isActiveConversation);
  // The swipe and the long-press sheet are the paths that replace the inline
  // ellipsis, and both are armed by a coarse pointer, so a device that has
  // neither hover nor a coarse pointer (a hoverless stylus) keeps the ellipsis:
  // right-click alone is not a path ordinary tapping or a screen reader finds.
  const showsTrailingControl = useShowsHoverAffordance(
    withContextMenu && isTouch,
  );

  /* Under the flag the row's trailing control is the Done check, never the
     ellipsis: Rename, Delete and the rest live in the row's right-click menu
     and in the chat header's title dropdown. The check takes the ellipsis's
     own slot, box and reveal, so nothing on the row moves. */
  const collapsesOut = sidebarDone && animateDone && !reduceMotion;

  /* The archive the collapse is waiting on. Held in a ref and fired at most
     once, because the animation is a courtesy and the write is not: the
     accepted click has to reach the daemon whether the animation finishes,
     is cut short by a navigation that unmounts the row, or never runs at all
     because the tab was backgrounded before its first frame. */
  const pendingDoneRef = useRef<(() => void) | null>(null);
  const runPendingDone = useCallback(() => {
    const run = pendingDoneRef.current;
    pendingDoneRef.current = null;
    run?.();
  }, []);
  useEffect(() => () => runPendingDone(), [runPendingDone]);

  const markDone = useCallback(() => {
    flash();
    if (!collapsesOut) {
      ctx.onArchive?.(conversation);
      return;
    }
    pendingDoneRef.current = () => ctx.onArchive?.(conversation);
    setLeaving(true);
    /* The backstop, not the usual path: `onAnimationComplete` gets there
       first whenever frames are running. */
    window.setTimeout(runPendingDone, DONE_EXIT_MS * 2);
  }, [collapsesOut, ctx, conversation, flash, runPendingDone]);

  const doneCheck =
    sidebarDone && ctx.onArchive && conversation.archivedAt == null ? (
      <Tooltip content={doneLabels.archive} side="right">
        <button
          type="button"
          aria-label={doneLabels.archive}
          onClick={(event) => {
            event.stopPropagation();
            markDone();
          }}
          /* No `onContextMenu` of its own, unlike the ellipsis it replaces:
             the ellipsis swallowed the event because it owned a menu, and
             this owns a command. Letting it through means a right-click over
             the check opens the row's menu as a right-click anywhere else on
             the row does, and the context-menu key with focus on the check
             reaches the same trigger. */
          className={ROW_TRAILING_CONTROL_CLASSES}
        >
          <Check size={14} aria-hidden className={ROW_TRAILING_GLYPH_CLASSES} />
        </button>
      </Tooltip>
    ) : undefined;

  const trailingAction = !showsTrailingControl ? undefined : sidebarDone ? (
    doneCheck
  ) : (
    <ConversationActionsMenu {...menuProps} shortcuts={shortcuts} />
  );

  const swipeProps = {
    // The row's shape, which is `PanelItem`'s radius: the layer a swipe
    // reveals behind the row inherits it, so no corner of the layer shows
    // past the row's own.
    className: "rounded-[6px]",
    leadingActions,
    trailingActions,
  };

  const rowBody = (
    <PanelItem
      label={displayTitle(conversation.title)}
      marqueeOnHover={marquee}
      active={isActiveConversation}
      onSelect={() => select(conversationId)}
      badge={
        hasThreadStatus(status) ? (
          <ThreadStatusIndicator {...status} />
        ) : undefined
      }
      badgeBare
      trailingAction={trailingAction}
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
        // of its own would lose its colour to it. It reads through the
        // row's hover property first so the active row matches whatever
        // its card hovers in: the assistant card publishes an accent wash
        // for hover, and a value stated on the row itself would beat it.
        ctx.overlayCards
          ? "min-h-[var(--side-menu-tile-size)] [--panel-item-active:var(--panel-item-hover,var(--surface-hover))]"
          : "h-[30px]",
      )}
    />
  );

  /* The row collapses and fades as it is marked done, then hands over to the
     archive, so the list closes the gap once rather than snapping shut under
     the pointer.

     Animated on the row's own box, never on a wrapper around it. An extra
     element between the list and the row is another child for the list's
     spacing to act on, which moved every row under the flag; the row the
     list lays out has to be the same element in both states. `overflow` is
     declared only while the row is leaving, because the box it is declared
     on is a flex item, and one that clips gives up its content-sized
     minimum (see `SwipeActionReveal`). At rest this writes `height: auto`
     and `opacity: 1`, which are the values the element already had. */
  const panelItem = collapsesOut ? (
    <MotionSwipeActionReveal
      {...swipeProps}
      initial={false}
      animate={
        leaving ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }
      }
      transition={{ duration: DONE_EXIT_MS / 1000, ease: "easeOut" }}
      style={leaving ? { overflow: "hidden" } : undefined}
      onAnimationComplete={() => {
        if (leaving) {
          runPendingDone();
        }
      }}
    >
      {rowBody}
    </MotionSwipeActionReveal>
  ) : (
    <SwipeActionReveal {...swipeProps}>{rowBody}</SwipeActionReveal>
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
          shortcuts,
          doneLabels,
          ...menuProps,
        })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
