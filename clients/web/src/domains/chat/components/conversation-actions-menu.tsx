import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  FolderInput,
  GitBranch,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  buildPanelMenuItem,
  PanelMenuDivider,
  type PanelMenuItemOptions,
} from "@/domains/chat/components/panel-menu-item";
import type { MoveToGroupTarget } from "@/domains/chat/utils/group-conversations";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation, type TFunction } from "@/i18n";
import { openExternalUrl } from "@/runtime/browser";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { READ_ICON, UNREAD_ICON } from "@/utils/read-state-icon";
import { BottomSheet, ContextMenu, Menu } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

/**
 * Hover-revealed "more" menu for a conversation row. Renders an ellipsis
 * button; clicking it opens a dropdown menu with Pin / Rename / Archive /
 * Delete / Mark as unread actions, plus an optional "Move to group" submenu.
 *
 * The same item set is also rendered by the row's right-click context menu
 * (`AssistantSideMenu`) via the shared `renderConversationMenuItems` helper
 * exported from this module — both surfaces stay byte-identical because
 * they consume one source of truth.
 *
 * On a touch-first surface (`useTouchMobile()`: narrow viewport and coarse
 * pointer), the dropdown is replaced with a `BottomSheet` that slides up from
 * the viewport bottom. See `renderConversationMenuItemsAsPanelItems` for the
 * parallel item builder.
 *
 * The ellipsis button sits in the parent `PanelItem`'s row, which tucks it
 * away only where the device can hover and keeps it present everywhere else.
 * While the menu is open the button stays visible, so the menu does not snap
 * closed as the pointer leaves the row on its way to an item.
 */

type MenuSide = "top" | "right" | "bottom" | "left";
type MenuAlign = "start" | "center" | "end";

/** Destructive row colour shared by the dropdown and the mobile sheet. */
const DELETE_ITEM_CLASS =
  "text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-hover)] [&_[data-slot=menu-item-icon]]:text-inherit";
const DELETE_SHEET_ITEM_CLASS =
  "text-[var(--system-negative-strong)] [--panel-item-icon-fg:var(--system-negative-strong)]";

/**
 * Subset of the compound-menu API shared by `Menu` and `ContextMenu`. The
 * shared `renderConversationMenuItems` helper accepts a value of this type
 * so a single source of truth produces items for both the dropdown trigger
 * (right-side ellipsis, topbar) and the row's right-click context menu.
 */
export type ConversationMenuPrimitive = {
  Item: typeof Menu.Item | typeof ContextMenu.Item;
  Separator: typeof Menu.Separator | typeof ContextMenu.Separator;
  Sub: typeof Menu.Sub | typeof ContextMenu.Sub;
  SubTrigger: typeof Menu.SubTrigger | typeof ContextMenu.SubTrigger;
  SubContent: typeof Menu.SubContent | typeof ContextMenu.SubContent;
};

export interface ConversationMenuItemsProps {
  /** True when the conversation is currently pinned (drives Pin / Unpin label). */
  isPinned?: boolean;
  /** True when the conversation is archived (drives Archive / Unarchive label). */
  isArchived?: boolean;
  /** Toggle the pinned state. Unwired callers can omit this; the row hides the menu item. */
  onPinToggle?: () => void;
  /** Prompt for a new title and persist it. */
  onRename?: () => void;
  /** Move the conversation to Archived. */
  onArchive?: () => void;
  /** Restore an archived conversation. When provided, takes precedence over `onArchive` when `isArchived` is true. */
  onUnarchive?: () => void;
  /**
   * Permanently delete the conversation. The host owns confirmation; this
   * callback only requests the delete. Available for channel threads too:
   * deletion is a local history wipe and does not write to the source channel.
   */
  onDelete?: () => void;
  /** Mark the most recent assistant message as unread. */
  onMarkUnread?: () => void;
  /**
   * When true, the "Mark as unread" item is rendered in a disabled state.
   * Use this for rows where the conversation cannot currently be marked
   * unread (no assistant message yet, already unread, suppressed group,
   * or no conversationId).
   */
  isMarkUnreadDisabled?: boolean;
  /**
   * Mark the conversation as read (clear the unread indicator). When
   * provided the menu renders "Mark as read" instead of "Mark as unread"
   * so the two actions never appear simultaneously — callers pass
   * whichever is appropriate for the current read state.
   */
  onMarkRead?: () => void;
  /**
   * Custom groups this conversation can be filed into, excluding the one it
   * already belongs to. Rendered as items in the "Move to group" submenu.
   */
  moveToGroups?: MoveToGroupTarget[];
  /** Move the conversation to an existing custom group. */
  onMoveToGroup?: (groupId: string) => void;
  /**
   * Create a new custom group and move the conversation into it. When
   * provided together with `onMoveToGroup`, a "Move to group" submenu is
   * shown with a "New group…" item — the only entry point for creating a
   * group (there is no standalone create button). Available even when
   * `moveToGroups` is empty.
   */
  onCreateGroupInto?: () => void;
  /**
   * Remove the conversation from its current custom group, falling back to
   * Recents. When provided, a "Remove from group" item appears at the end of
   * the submenu. Callers pass this only for conversations that belong to a
   * custom group.
   */
  onRemoveFromGroup?: () => void;
  /**
   * Hide write-affording menu items (Mark-as-read/unread) when
   * the conversation is read-only. Items are hidden entirely, not
   * disabled. Today this fires for channel-bound conversations (Slack,
   * Telegram, voice) where outbound writes aren't mirrored back to the
   * source channel; future read-only sources (e.g. daemon-side locks)
   * can feed the same gate.
   *
   * Archive/Unarchive intentionally stay available even when read-only
   * — moving a thread out of the active sidebar is an organizational
   * action that doesn't write to the source channel, and channel
   * conversations accumulate faster than native ones so users need
   * to be able to tidy them up.
   */
  isReadonly?: boolean;
  /** Open this conversation in a new browser tab. */
  onOpenInNewWindow?: () => void;
  /** Fork the conversation through the latest persisted message. */
  onForkConversation?: () => void;
  /** Open the Share Feedback modal for this conversation. */
  onShareFeedback?: () => void;
  /**
   * Open the per-conversation LLM context inspector. When provided, an
   * "Inspect" item appears at the bottom of the action set — power-user
   * affordance for debugging the assistant's prompt/response/memory
   * decisions per message.
   */
  onInspect?: () => void;
  /** Copy the full conversation as markdown to the clipboard. */
  onCopyConversation?: () => void;
  /**
   * Copy the conversation's id to the clipboard. Lets users paste a precise
   * reference into chat (the assistant resolves conversation ids directly).
   */
  onCopyConversationId?: () => void;
  /** Re-fetch the chat context and reload the current conversation. */
  onRefresh?: () => void;
  /**
   * Deep link back to the conversation's source thread/message in the
   * originating external channel (e.g. the Slack thread). When provided,
   * an "Open in <channel>" item appears alongside the other open actions —
   * the same destination as the top-bar source pill, kept in the menu so
   * the link stays discoverable from the conversation heading.
   */
  channelSourceLink?: { href: string; label: string } | null;
  /** Controls item order and labels. "header" uses macOS-parity order; "sidebar" preserves the original order. */
  variant?: "header" | "sidebar";
}

/**
 * Render the conversation row's menu items into either a `Menu` or a
 * `ContextMenu`. Both namespaces expose the same `Item / Separator` shape;
 * passing one in via `Primitive` keeps the dropdown trigger and the
 * right-click context menu in lockstep without duplicating the item list.
 */
export function renderConversationMenuItems({
  Primitive,
  t,
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  moveToGroups,
  onMoveToGroup,
  onCreateGroupInto,
  onRemoveFromGroup,
  isReadonly = false,
  onForkConversation,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onCopyConversation,
  onCopyConversationId,
  onRefresh,
  channelSourceLink,
  variant = "sidebar",
}: ConversationMenuItemsProps & {
  Primitive: ConversationMenuPrimitive;
  /** Threaded in: these builders are plain functions, so they cannot hold
   *  the hook themselves and their callers own the reactive binding. */
  t: TFunction<"chat">;
}): ReactNode {
  // The submenu shows whenever move + create are wired, even with zero
  // existing groups — "New group…" is always a valid action and is the only
  // way to create a group.
  const showMoveToGroup = Boolean(onMoveToGroup && onCreateGroupInto);

  const pinItem = onPinToggle ? (
    <Primitive.Item
      leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
      onSelect={onPinToggle}
    >
      {isPinned ? t("conversationActions.unpin") : t("conversationActions.pin")}
    </Primitive.Item>
  ) : null;

  const renameItem = onRename ? (
    <Primitive.Item leftIcon={<Pencil size={14} />} onSelect={onRename}>
      {t("conversationActions.rename")}
    </Primitive.Item>
  ) : null;

  const archiveItem =
    isArchived && onUnarchive ? (
      <Primitive.Item
        leftIcon={<ArchiveRestore size={14} />}
        onSelect={onUnarchive}
      >
        {t("conversationActions.unarchive")}
      </Primitive.Item>
    ) : onArchive ? (
      <Primitive.Item leftIcon={<Archive size={14} />} onSelect={onArchive}>
        {t("conversationActions.archive")}
      </Primitive.Item>
    ) : null;

  const deleteItem = onDelete ? (
    <Primitive.Item
      leftIcon={<Trash2 size={14} />}
      onSelect={onDelete}
      className={DELETE_ITEM_CLASS}
    >
      {t("conversationActions.delete")}
    </Primitive.Item>
  ) : null;

  const markReadUnreadItem =
    !isReadonly && onMarkRead ? (
      <Primitive.Item
        leftIcon={<UNREAD_ICON size={14} />}
        onSelect={onMarkRead}
      >
        {t("conversationActions.markRead")}
      </Primitive.Item>
    ) : !isReadonly && onMarkUnread ? (
      <Primitive.Item
        leftIcon={<READ_ICON size={14} />}
        onSelect={onMarkUnread}
        disabled={isMarkUnreadDisabled}
      >
        {t("conversationActions.markUnread")}
      </Primitive.Item>
    ) : null;

  const moveToGroupItem = showMoveToGroup ? (
    <Primitive.Sub>
      <Primitive.SubTrigger leftIcon={<FolderInput size={14} />}>
        {t("conversationActions.moveToGroup")}
      </Primitive.SubTrigger>
      <Primitive.SubContent>
        {(moveToGroups ?? []).map((group) => (
          <Primitive.Item
            key={group.id}
            onSelect={() => onMoveToGroup?.(group.id)}
          >
            {group.name}
          </Primitive.Item>
        ))}
        {moveToGroups && moveToGroups.length > 0 ? (
          <Primitive.Separator />
        ) : null}
        <Primitive.Item onSelect={onCreateGroupInto}>
          {t("conversationActions.newGroup")}
        </Primitive.Item>
        {onRemoveFromGroup ? (
          <>
            <Primitive.Separator />
            <Primitive.Item onSelect={onRemoveFromGroup}>
              {t("conversationActions.removeFromGroup")}
            </Primitive.Item>
          </>
        ) : null}
      </Primitive.SubContent>
    </Primitive.Sub>
  ) : null;

  const openInNewWindowItem = onOpenInNewWindow ? (
    <Primitive.Item
      leftIcon={<ExternalLink size={14} />}
      onSelect={onOpenInNewWindow}
    >
      {t("conversationActions.openInNewWindow")}
    </Primitive.Item>
  ) : null;

  const channelSourceLinkItem = channelSourceLink ? (
    <Primitive.Item
      leftIcon={<ExternalLink size={14} />}
      onSelect={() => void openExternalUrl(channelSourceLink.href)}
    >
      {channelSourceLink.label}
    </Primitive.Item>
  ) : null;

  const inspectItem = onInspect ? (
    <Primitive.Item leftIcon={<Sparkles size={14} />} onSelect={onInspect}>
      {t("conversationActions.inspect")}
    </Primitive.Item>
  ) : null;

  const copyConversationIdItem = onCopyConversationId ? (
    <Primitive.Item
      leftIcon={<Copy size={14} />}
      onSelect={onCopyConversationId}
    >
      {t("conversationActions.copyConversationId")}
    </Primitive.Item>
  ) : null;

  if (variant === "header") {
    return (
      <>
        {onCopyConversation ? (
          <Primitive.Item
            leftIcon={<Copy size={14} />}
            onSelect={onCopyConversation}
          >
            {t("conversationActions.copyConversation")}
          </Primitive.Item>
        ) : null}

        {onForkConversation ? (
          <Primitive.Item
            leftIcon={<GitBranch size={14} />}
            onSelect={onForkConversation}
          >
            {t("conversationActions.forkConversation")}
          </Primitive.Item>
        ) : null}

        {inspectItem}
        {channelSourceLinkItem}
        {openInNewWindowItem}

        {onRefresh ? (
          <Primitive.Item
            leftIcon={<RefreshCw size={14} />}
            onSelect={onRefresh}
          >
            {t("conversationActions.refresh")}
          </Primitive.Item>
        ) : null}

        {pinItem}
        {renameItem}
        {moveToGroupItem}
        {archiveItem}
        {deleteItem}
        {copyConversationIdItem}
      </>
    );
  }

  return (
    <>
      {pinItem}
      {renameItem}
      {archiveItem}
      {deleteItem}

      {markReadUnreadItem}
      {moveToGroupItem}
      {channelSourceLinkItem}
      {openInNewWindowItem}

      {onShareFeedback ? (
        <>
          <Primitive.Separator />
          <Primitive.Item
            leftIcon={<MessageCircle size={14} />}
            onSelect={onShareFeedback}
          >
            {t("conversationActions.shareFeedback")}
          </Primitive.Item>
        </>
      ) : null}

      {copyConversationIdItem || inspectItem ? (
        <>
          <Primitive.Separator />
          {copyConversationIdItem}
          {inspectItem}
        </>
      ) : null}
    </>
  );
}

/**
 * The sheet's leading affordance: a 40px circle carrying the action's glyph,
 * which is what separates a touch action list from the dense 14px rows the
 * dropdown uses.
 *
 * The glyph reads `--panel-item-icon-fg`, the property `PanelItem` colours a
 * bare icon with, so a chip picks up any tint the surrounding surface sets
 * instead of pinning a colour the rest of the row would not follow.
 */
function actionChip(Icon: LucideIcon): ReactNode {
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--border-hover)]"
    >
      <Icon
        size={16}
        className="text-[color:var(--panel-item-icon-fg,var(--content-secondary))]"
      />
    </span>
  );
}

/**
 * Row geometry for the sheet. The chip is the row's height, so the row's own
 * vertical padding becomes the gap between rows: 8px here reproduces the
 * mock's 16px rhythm while leaving a 56px target to tap, which the 40px chip
 * alone would not. Horizontal padding goes to zero because the sheet body
 * already insets the column.
 */
const SHEET_ROW_CLASSES = "px-0 py-2 max-md:py-2";

/** Indent for the rows under "Move to group", aligning them past the chip column. */
const SHEET_SUBROW_CLASSES = "pl-[52px]";

/**
 * A sheet row: {@link buildPanelMenuItem} with the chip and row geometry
 * applied. Every row in this surface goes through it, so no call site can
 * forget the chip and render a bare glyph next to eight chipped neighbours.
 */
function buildSheetMenuItem({
  icon,
  className,
  disabled,
  ...options
}: PanelMenuItemOptions): ReactNode {
  return buildPanelMenuItem({
    ...options,
    disabled,
    leadingSlot: icon ? actionChip(icon) : undefined,
    className: cn(
      SHEET_ROW_CLASSES,
      // Both of these are conditional because `buildPanelMenuItem` expresses
      // "disabled" as a text colour: an unconditional brighter label here
      // would merge straight over the dim treatment and leave a disabled row
      // looking live. The chip follows the label through the property it
      // already reads for its glyph.
      disabled
        ? "[--panel-item-icon-fg:var(--content-disabled)]"
        : "text-[var(--content-default)]",
      className,
    ),
  });
}

/**
 * Mobile-only renderer for the bottom-sheet surface. Returns the same
 * conceptual item set as `renderConversationMenuItems` but flattened into
 * `PanelItem` rows.
 */
export function renderConversationMenuItemsAsPanelItems({
  t,
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  moveToGroups,
  onMoveToGroup,
  onCreateGroupInto,
  onRemoveFromGroup,
  isReadonly = false,
  onForkConversation,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onCopyConversation,
  onCopyConversationId,
  onRefresh,
  channelSourceLink,
  variant = "sidebar",
  onClose,
  isNativePlatform = false,
}: ConversationMenuItemsProps & {
  onClose: () => void;
  isNativePlatform?: boolean;
  t: TFunction<"chat">;
}): ReactNode {
  // BottomSheet is a single-level surface, so the "Move to group" submenu is
  // flattened into an inline labeled block (mirrors the desktop submenu).
  const showMoveToGroup = Boolean(onMoveToGroup && onCreateGroupInto);
  const pinItem = onPinToggle
    ? buildSheetMenuItem({
        key: "pin",
        icon: isPinned ? PinOff : Pin,
        label: isPinned
          ? t("conversationActions.unpin")
          : t("conversationActions.pin"),
        run: onPinToggle,
        onClose,
      })
    : null;

  const renameItem = onRename
    ? buildSheetMenuItem({
        key: "rename",
        icon: Pencil,
        label: t("conversationActions.rename"),
        run: onRename,
        onClose,
      })
    : null;

  const archiveItem =
    isArchived && onUnarchive
      ? buildSheetMenuItem({
          key: "unarchive",
          icon: ArchiveRestore,
          label: t("conversationActions.unarchive"),
          run: onUnarchive,
          onClose,
        })
      : onArchive
        ? buildSheetMenuItem({
            key: "archive",
            icon: Archive,
            label: t("conversationActions.archive"),
            run: onArchive,
            onClose,
          })
        : null;

  const deleteItem = onDelete
    ? buildSheetMenuItem({
        key: "delete",
        icon: Trash2,
        label: t("conversationActions.delete"),
        className: DELETE_SHEET_ITEM_CLASS,
        run: onDelete,
        onClose,
      })
    : null;

  const markReadUnreadItem =
    !isReadonly && onMarkRead
      ? buildSheetMenuItem({
          key: "mark-read",
          icon: UNREAD_ICON,
          label: t("conversationActions.markRead"),
          run: onMarkRead,
          onClose,
        })
      : !isReadonly && onMarkUnread
        ? buildSheetMenuItem({
            key: "mark-unread",
            icon: READ_ICON,
            label: t("conversationActions.markUnread"),
            disabled: isMarkUnreadDisabled,
            run: onMarkUnread,
            onClose,
          })
        : null;

  const moveToGroupBlock = showMoveToGroup ? (
    <>
      <PanelMenuDivider />
      <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-body-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
        <FolderInput size={14} aria-hidden />
        {t("conversationActions.moveToGroup")}
      </div>
      {(moveToGroups ?? []).map((group) =>
        buildSheetMenuItem({
          key: `move-to-${group.id}`,
          label: group.name,
          className: SHEET_SUBROW_CLASSES,
          run: () => onMoveToGroup?.(group.id),
          onClose,
        }),
      )}
      {buildSheetMenuItem({
        key: "move-to-new-group",
        label: t("conversationActions.newGroup"),
        className: SHEET_SUBROW_CLASSES,
        run: () => onCreateGroupInto?.(),
        onClose,
      })}
      {onRemoveFromGroup
        ? buildSheetMenuItem({
            key: "remove-from-group",
            label: t("conversationActions.removeFromGroup"),
            className: SHEET_SUBROW_CLASSES,
            run: onRemoveFromGroup,
            onClose,
          })
        : null}
    </>
  ) : null;

  const openInNewWindowItem =
    onOpenInNewWindow && !isNativePlatform
      ? buildSheetMenuItem({
          key: "open-in-new-window",
          icon: ExternalLink,
          label: t("conversationActions.openInNewWindow"),
          run: onOpenInNewWindow,
          onClose,
        })
      : null;

  const channelSourceLinkItem = channelSourceLink
    ? buildSheetMenuItem({
        key: "channel-source-link",
        icon: ExternalLink,
        label: channelSourceLink.label,
        run: () => void openExternalUrl(channelSourceLink.href),
        onClose,
      })
    : null;

  const inspectItem = onInspect
    ? buildSheetMenuItem({
        key: "inspect",
        icon: Sparkles,
        label: t("conversationActions.inspect"),
        run: onInspect,
        onClose,
      })
    : null;

  const copyConversationIdItem = onCopyConversationId
    ? buildSheetMenuItem({
        key: "copy-conversation-id",
        icon: Copy,
        label: t("conversationActions.copyConversationId"),
        run: onCopyConversationId,
        onClose,
      })
    : null;

  if (variant === "header") {
    return (
      <>
        {onCopyConversation
          ? buildSheetMenuItem({
              key: "copy",
              icon: Copy,
              label: t("conversationActions.copyConversation"),
              run: onCopyConversation,
              onClose,
            })
          : null}

        {onForkConversation
          ? buildSheetMenuItem({
              key: "fork",
              icon: GitBranch,
              label: t("conversationActions.forkConversation"),
              run: onForkConversation,
              onClose,
            })
          : null}

        {inspectItem}
        {channelSourceLinkItem}
        {openInNewWindowItem}

        {onRefresh
          ? buildSheetMenuItem({
              key: "refresh",
              icon: RefreshCw,
              label: t("conversationActions.refresh"),
              run: onRefresh,
              onClose,
            })
          : null}

        {pinItem}
        {renameItem}
        {archiveItem}
        {deleteItem}
        {moveToGroupBlock}
        {copyConversationIdItem}
      </>
    );
  }

  return (
    <>
      {pinItem}
      {renameItem}
      {archiveItem}
      {deleteItem}
      {markReadUnreadItem}
      {moveToGroupBlock}
      {channelSourceLinkItem}
      {openInNewWindowItem}

      {onShareFeedback ? (
        <>
          <PanelMenuDivider />
          {buildSheetMenuItem({
            key: "share-feedback",
            icon: MessageCircle,
            label: t("conversationActions.shareFeedback"),
            run: onShareFeedback,
            onClose,
          })}
        </>
      ) : null}

      {copyConversationIdItem || inspectItem ? (
        <>
          <PanelMenuDivider />
          {copyConversationIdItem}
          {inspectItem}
        </>
      ) : null}
    </>
  );
}

/**
 * Controlled bottom-sheet surface for a conversation's actions. Extracted so
 * both the trailing ellipsis menu and the row long-press gesture open the same
 * sheet with an identical item set (via the shared
 * `renderConversationMenuItemsAsPanelItems` builder) — no drift between the two
 * entry points. `open` / `onOpenChange` are controlled by the caller.
 *
 * When `trigger` is provided it is wired through `BottomSheet.Trigger` (used by
 * the ellipsis menu, whose custom triggers must open the sheet on tap). The row
 * long-press omits `trigger` and drives `open` directly from the gesture.
 */
export function ConversationActionsSheet({
  open,
  onOpenChange,
  trigger,
  ...itemProps
}: ConversationMenuItemsProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
}) {
  const isNativePlatform = useIsNativePlatform();
  const { t } = useTranslation("chat");
  return (
    <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
      ) : null}
      {/* This sheet's item list is open-ended (bulk actions, "Move to
          group" targets, …), so it grows with its content rather than
          taking the shared default's 50dvh ceiling. `!` forces this over
          that default: cross-package Tailwind generation order doesn't
          reliably favor a plain (unmarked) override here. Once content
          would come within 120px of the top of the screen, the sheet stops
          growing and its body scrolls instead. */}
      {/* `padded={false}`: the bands below carry different insets, the header
          sitting tighter to the grabber than the rows sit to each other, which
          the shared uniform padding cannot express. An unpadded sheet owns its
          safe-area allowance, hence the bottom padding here. */}
      <BottomSheet.Content
        aria-describedby={undefined}
        padded={false}
        className="max-h-[calc(100dvh-120px)]! pt-2 pb-[calc(24px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
      >
        <BottomSheet.Grabber />
        <BottomSheet.Header className="flex-row items-center justify-between px-4 pt-3 pb-2">
          <BottomSheet.Title className="text-body-large-default text-[var(--content-tertiary)]">
            {t("conversationActionsSheet.title")}
          </BottomSheet.Title>
          {/* `-m-2 p-2` grows the tap target to 32px without moving the
              glyph or changing the header's height. */}
          <BottomSheet.Close
            aria-label={t("conversationActionsSheet.closeAriaLabel")}
            className="-m-2 flex shrink-0 items-center justify-center p-2 text-[var(--content-tertiary)] outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
          >
            <X size={16} aria-hidden />
          </BottomSheet.Close>
        </BottomSheet.Header>
        {/* Scrollbar hidden, not just at rest: this sheet has no fixed
            track-width budget to spare, so a hover-revealed thumb would
            shift the row content instead. Scroll itself (wheel/trackpad/
            touch) is unaffected. */}
        <BottomSheet.Body className="px-4 pt-3 [--panel-item-gap:12px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {renderConversationMenuItemsAsPanelItems({
            ...itemProps,
            t,
            onClose: () => onOpenChange(false),
            isNativePlatform,
          })}
        </BottomSheet.Body>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}

export interface ConversationActionsMenuProps extends ConversationMenuItemsProps {
  /**
   * Override the default hover-revealed ellipsis button with a custom
   * trigger (e.g. the topbar thread-name dropdown). The element is
   * wrapped in Radix `Menu.Trigger asChild`, so it must be a
   * native button/anchor or a component that forwards ref.
   */
  trigger?: ReactNode;
  /** Menu positioning — defaults reproduce the row-aligned ellipsis menu. */
  side?: MenuSide;
  align?: MenuAlign;
  sideOffset?: number;
}

export function ConversationActionsMenu({
  trigger,
  side = "right",
  align = "start",
  sideOffset = 4,
  ...itemProps
}: ConversationActionsMenuProps) {
  const isTouchMobile = useTouchMobile();
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);

  const defaultTrigger = (
    <button
      type="button"
      aria-label={t("conversationActions.triggerAriaLabel")}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)] max-md:h-[30px] max-md:w-[30px]"
    >
      <MoreHorizontal size={14} aria-hidden className="max-md:h-[21px] max-md:w-[21px]" />
    </button>
  );

  const resolvedTrigger = trigger ?? defaultTrigger;

  if (isTouchMobile) {
    // The sheet body is the shared controlled surface (ConversationActionsSheet
    // uses the same builder), so the trailing-ellipsis menu and the row
    // long-press never drift. The trigger stays wired through BottomSheet so a
    // custom `trigger` (e.g. the topbar thread-name dropdown) keeps working.
    return (
      <ConversationActionsSheet
        {...itemProps}
        open={open}
        onOpenChange={setOpen}
        trigger={resolvedTrigger}
      />
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>{resolvedTrigger}</Menu.Trigger>
      <Menu.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        onClick={(event) => event.stopPropagation()}
      >
        {renderConversationMenuItems({ Primitive: Menu, t, ...itemProps })}
      </Menu.Content>
    </Menu.Root>
  );
}
