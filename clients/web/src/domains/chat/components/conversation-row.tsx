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
import {
  animate,
  useReducedMotion,
  type AnimationPlaybackControls,
} from "motion/react";

import { useCallback, useEffect, useRef } from "react";

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
   * Whether the row is an item of a windowed list. Virtuoso reports an item
   * measured at zero height as an error, with the element attached, so a row
   * leaving a windowed list closes to {@link WINDOWED_CLOSED_HEIGHT_PX}
   * rather than to nothing. The archive removes it on the next frame.
   */
  windowed?: boolean;
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
 * Exported for the other conversation-row surfaces (the All chats page), so
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
 * The two halves of a row leaving once it is marked done. The row's content
 * slides out to the left and fades, then the row's box closes so the
 * rows around it slide together over the space it held. The close starts
 * before the slide ends, so the two read as one motion rather than as a
 * slide followed by a snap. Short enough to read as the row leaving rather
 * than as a wait for it.
 */
const DONE_SLIDE_S = 0.2;
const DONE_CLOSE_DELAY_S = 0.12;
const DONE_CLOSE_S = 0.2;
const DONE_EXIT_MS = (DONE_CLOSE_DELAY_S + DONE_CLOSE_S) * 1000;

/** How far a row in a windowed list closes: the least virtuoso accepts. */
const WINDOWED_CLOSED_HEIGHT_PX = 1;

/**
 * The space a list puts between this row and the next, which the row's box
 * gives back as it closes: a box closed to zero height still has its gap
 * beside it, and a gap that vanished only when the row unmounted would jump
 * the rows below by that much at the end. The sidebar's lists space their
 * rows with a flex gap that varies by surface (zeroed inside a card), and a
 * windowed list's item has no gap at all, so it is read off the list rather
 * than assumed. The list is the nearest ancestor that lays the row out: the
 * touch path's long-press wrapper is `display: contents` and lays out
 * nothing.
 */
function listGapPx(box: HTMLElement): number {
  let list = box.parentElement;
  while (list && getComputedStyle(list).display === "contents") {
    list = list.parentElement;
  }
  if (!list) {
    return 0;
  }
  const gap = parseFloat(getComputedStyle(list).rowGap);
  return Number.isFinite(gap) ? gap : 0;
}

export function ConversationRow({
  conversation,
  withContextMenu = true,
  marquee = true,
  onSelect,
  windowed = false,
}: ConversationRowProps) {
  const ctx = useConversationListContext();
  const { conversationId } = conversation;
  const { t } = useTranslation("chat");
  const displayTitle = useDisplayConversationTitle();
  const sidebarDone = useSidebarDoneEnabled();
  const doneLabels = useConversationDoneLabels();
  const reduceMotion = useReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

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
  const animatesOut = sidebarDone && !reduceMotion;

  /* The archive the exit is waiting on. Held in a ref and fired at most
     once, because the animation is a courtesy and the write is not: the
     accepted click has to reach the daemon whether the animation finishes,
     is cut short by a navigation that unmounts the row, or never runs at all
     because the tab was backgrounded before its first frame. */
  const pendingDoneRef = useRef<(() => void) | null>(null);
  const exitRef = useRef<AnimationPlaybackControls[]>([]);
  const runPendingDone = useCallback(() => {
    const run = pendingDoneRef.current;
    pendingDoneRef.current = null;
    run?.();
  }, []);
  useEffect(
    () => () => {
      for (const controls of exitRef.current) {
        controls.stop();
      }
      runPendingDone();
    },
    [runPendingDone],
  );

  /* The row leaves in two moves, then hands over to the archive, so the list
     closes the space once rather than snapping shut under the pointer. The
     row slides out to the left and fades; its box then closes, height
     and the list's gap together, and the rows around it slide together over
     the space it held. The box clips the slide, so a row sliding out never
     widens the scroller it sits in.

     Driven on the two elements the row already renders rather than through
     animated wrappers, so the list lays out the same element with the same
     single child in both flag states, and neither carries an inline value
     at rest. The row unmounts once the archive lands, so nothing written
     here has to be put back.

     A windowed list plays it too: virtuoso measures its items with a resize
     observer, so the box closing is a size change it follows frame by frame.
     There the box stops a pixel short of closed (see `windowed`). */
  const markDone = useCallback(() => {
    const box = boxRef.current;
    const row = rowRef.current;
    if (!animatesOut || !box || !row) {
      ctx.onArchive?.(conversation);
      return;
    }
    if (pendingDoneRef.current) {
      return;
    }
    pendingDoneRef.current = () => ctx.onArchive?.(conversation);
    const gap = listGapPx(box);
    box.style.overflow = "hidden";
    const slide = animate(
      row,
      { x: "-100%", opacity: 0 },
      { duration: DONE_SLIDE_S, ease: [0.4, 0, 1, 1] },
    );
    const close = animate(
      box,
      {
        height: [box.offsetHeight, windowed ? WINDOWED_CLOSED_HEIGHT_PX : 0],
        marginBottom: [0, -gap],
      },
      {
        duration: DONE_CLOSE_S,
        delay: DONE_CLOSE_DELAY_S,
        ease: [0.4, 0, 0.2, 1],
      },
    );
    exitRef.current = [slide, close];
    void close.then(runPendingDone);
    /* The backstop, not the usual path: the close gets there first whenever
       frames are running. */
    window.setTimeout(runPendingDone, DONE_EXIT_MS * 2);
  }, [animatesOut, ctx, conversation, runPendingDone, windowed]);

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
      ref={rowRef}
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

  const panelItem = (
    <SwipeActionReveal {...swipeProps} ref={boxRef}>
      {rowBody}
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
          shortcuts,
          doneLabels,
          ...menuProps,
        })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
