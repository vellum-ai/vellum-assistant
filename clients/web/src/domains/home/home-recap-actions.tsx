import {
  Ellipsis,
  MessageSquare,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import type { ReactNode } from "react";

import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
import type { TFunction } from "@/i18n";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";
import { ActionMenu, cn, Tooltip } from "@vellumai/design-library";

import { buildReadToggle } from "./read-toggle";

/**
 * The commands a recap row offers, in one list that every surface reaching them
 * renders from: the row's inline buttons, the swipe behind the row, and the
 * sheet a long press opens. Three hand-maintained copies of the same commands is
 * how a row ends up dismissable by one gesture and not another.
 */
export interface RecapAction {
  id: string;
  /** Names the control, and labels the row in the sheet and behind a swipe. */
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Painted in the negative colour, for a command that discards the item. */
  destructive?: boolean;
  /**
   * The edge a swipe reveals this command from. A command with no edge is
   * reachable by long press and by pointer, which suits one that navigates
   * rather than acting on the row: a swipe that scrolls the app out from under
   * the thumb is a surprise, where an undoable state change is not.
   *
   * Rows under the chat shell keep their commands on the trailing edge, since a
   * rightward drag there belongs to the navigation drawer. See
   * `clients/web/docs/PLATFORM_ADAPTATION.md`, "Swipe edges under the chat
   * shell".
   */
  swipeEdge?: "leading" | "trailing";
  /** Show the label beside the glyph rather than only as the accessible name. */
  showsLabel?: boolean;
}

export type HomeRecapRowTrailingAction = "dismiss" | "restore";

export interface RecapActionsOptions {
  item: FeedItem;
  isUnread: boolean;
  /**
   * Conversations the feed can still open. An item pointing at a conversation
   * outside this set drops its thread command rather than offering a dead end.
   * Absent means every conversation is reachable.
   */
  validConversationIds?: Set<string>;
  onDismiss: (itemId: string) => void;
  onToggleRead?: (itemId: string, newStatus: FeedItemStatus) => void;
  onGoToThread?: (conversationId: string) => void;
  trailingAction: HomeRecapRowTrailingAction;
  t: TFunction<"home">;
}

export function buildRecapActions({
  item,
  isUnread,
  validConversationIds,
  onDismiss,
  onToggleRead,
  onGoToThread,
  trailingAction,
  t,
}: RecapActionsOptions): RecapAction[] {
  if (trailingAction === "restore") {
    return [
      {
        id: "restore",
        label: t("actions.restore"),
        icon: RotateCcw,
        onSelect: () => onDismiss(item.id),
        swipeEdge: "trailing",
        showsLabel: true,
      },
    ];
  }

  const actions: RecapAction[] = [];

  if (onToggleRead) {
    const readToggle = buildReadToggle(isUnread, t);
    actions.push({
      id: "toggle-read",
      label: readToggle.label,
      icon: readToggle.icon,
      onSelect: () => onToggleRead(item.id, readToggle.nextStatus),
      swipeEdge: "trailing",
    });
  }

  const conversationId = item.conversationId;
  if (
    onGoToThread &&
    conversationId != null &&
    (!validConversationIds || validConversationIds.has(conversationId))
  ) {
    actions.push({
      id: "go-to-thread",
      label: t("actions.goToThread"),
      icon: MessageSquare,
      onSelect: () => {
        // Opening the thread is reading the item, so the two never disagree
        // about whether the user has seen it.
        if (isUnread && onToggleRead) {
          onToggleRead(item.id, "seen");
        }
        onGoToThread(conversationId);
      },
    });
  }

  actions.push({
    id: "dismiss",
    label: t("actions.dismiss"),
    icon: Trash2,
    onSelect: () => onDismiss(item.id),
    destructive: true,
    swipeEdge: "trailing",
  });

  return actions;
}

/** The actions a swipe from one edge reveals, in the order they are listed. */
export function swipeActionsFor(
  actions: RecapAction[],
  edge: "leading" | "trailing",
): SwipeAction[] {
  return actions
    .filter((action) => action.swipeEdge === edge)
    .map((action): SwipeAction => {
      return {
        id: action.id,
        label: action.label,
        icon: action.icon,
        variant: action.destructive ? "destructive" : "default",
        onSelect: action.onSelect,
      };
    });
}

/** A glyph control in the row's trailing cell, square unless it carries a label. */
const ACTION_CONTROL_CLASS = cn(
  "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md",
  "text-[var(--content-secondary)] transition-colors",
  "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
);

/**
 * The row's inline controls, revealed with the row where the device can hover.
 *
 * Each button stops the click reaching the card's stretched link behind it, so
 * dismissing an item does not also open it.
 */
export function RecapActionButtons({ actions }: { actions: RecapAction[] }) {
  return (
    <>
      {actions.map(({ id, label, icon: Icon, onSelect, showsLabel }) => (
        <Tooltip key={id} content={label}>
          <button
            type="button"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            className={cn(
              ACTION_CONTROL_CLASS,
              showsLabel && "w-auto gap-[var(--app-spacing-xs)] px-2",
            )}
          >
            <Icon width={16} height={16} aria-hidden="true" />
            {showsLabel ? (
              <span className="text-body-small-default">{label}</span>
            ) : null}
          </button>
        </Tooltip>
      ))}
    </>
  );
}

/**
 * The one control that reaches the commands where the device cannot hover,
 * opening the same sheet a long press does.
 *
 * A gesture is an accelerator and cannot be the only route: a swipe's buttons
 * are outside the accessibility tree until the swipe reveals them, and a long
 * press is not something a screen reader or switch control announces. This
 * button is, which is what keeps every command reachable by name.
 *
 * It is the sheet's own trigger rather than a button that sets the sheet's
 * state, so the dialog's state is announced on it and closing the sheet returns
 * focus to it: a keyboard or switch user running one command lands back beside
 * the row instead of at the top of the page.
 */
export function RecapActionsTrigger({ label }: { label: string }) {
  return (
    <ActionMenu.Trigger
      asChild={false}
      aria-label={label}
      /* `pointer-events-auto`: the card's content stack takes no pointer events
         so the stretched link behind it answers a tap anywhere, which every
         control standing above it has to opt back out of. */
      className={cn(ACTION_CONTROL_CLASS, "pointer-events-auto")}
    >
      <Ellipsis width={16} height={16} aria-hidden="true" />
    </ActionMenu.Trigger>
  );
}

/**
 * The row and the sheet its commands open, as one surface: whatever opens the
 * sheet (the row's trigger, a long press) drives the same state and reaches the
 * same commands.
 *
 * The presentation is pinned rather than resolved from input capability: the
 * sheet stands in for the row's inline buttons wherever those are absent, which
 * is the hoverless case the sheet is already the right surface for.
 *
 * The sheet's content is a sibling of `children` rather than nested inside it,
 * because a long press guards the row against the click its own release emits
 * and React would route the sheet's first tap through that guard.
 */
export function RecapActions({
  actions,
  title,
  open,
  onOpenChange,
  children,
}: {
  actions: RecapAction[];
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <ActionMenu.Root
      open={open}
      onOpenChange={onOpenChange}
      presentation="sheet"
    >
      {children}
      <ActionMenu.Content title={title} showTitle>
        {actions.map(({ id, label, icon, onSelect, destructive }) => (
          <ActionMenu.Item
            key={id}
            icon={icon}
            label={label}
            tone={destructive ? "destructive" : "default"}
            onSelect={onSelect}
          />
        ))}
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
