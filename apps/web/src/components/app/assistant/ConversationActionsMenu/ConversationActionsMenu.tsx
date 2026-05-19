
import {
  Archive,
  ArchiveRestore,
  Circle,
  CircleCheck,
  Copy,
  ExternalLink,
  FolderInput,
  GitBranch,
  MessageCircle,
  Microscope,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { BottomSheet } from "@vellum/design-library/components/bottom-sheet";
import { ContextMenu } from "@vellum/design-library/components/context-menu";
import { Menu } from "@vellum/design-library/components/menu";
import { PanelItem } from "@/components/app/core/PanelItem/PanelItem.js";
import type { MoveToGroupTarget } from "@/domains/chat/lib/groupConversations.js";
import { useIsMobile } from "@/lib/hooks/useIsMobile.js";

/**
 * Hover-revealed "more" menu for a conversation row. Renders an ellipsis
 * button; clicking it opens a dropdown menu with Pin / Rename / Archive /
 * Mark as unread actions, plus an optional "Move to Group" submenu.
 *
 * The same item set is also rendered by the row's right-click context menu
 * (`AssistantSideMenu`) via the shared `renderConversationMenuItems` helper
 * exported from this module — both surfaces stay byte-identical because
 * they consume one source of truth.
 *
 * On mobile (`useIsMobile() === true`), the dropdown is replaced with a
 * `BottomSheet` that slides up from the viewport bottom — see
 * `renderConversationMenuItemsAsPanelItems` for the parallel item builder.
 *
 * The ellipsis button is hidden by default and revealed via `group-hover`
 * on the parent `PanelItem`'s row. When the menu is open the button stays
 * visible so the menu doesn't snap closed as the mouse leaves the row
 * on its way to a menu item.
 */

type MenuSide = "top" | "right" | "bottom" | "left";
type MenuAlign = "start" | "center" | "end";

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
   * Groups available as "Move to Group" targets, excluding the
   * conversation's current group. When non-empty and `onMoveToGroup`
   * is provided, a submenu appears listing these targets.
   */
  moveToGroups?: MoveToGroupTarget[];
  /** Move the conversation to the specified group. */
  onMoveToGroup?: (groupId: string) => void;
  /**
   * Remove the conversation from its current (non-system) group, falling
   * back to Recents. When provided, appends a separator + "Remove from
   * group" item at the end of the Move-to-Group submenu. Callers should
   * only supply this for conversations that belong to a non-system group
   * (i.e. `groupId && !groupId.startsWith("system:")`).
   */
  onRemoveFromGroup?: () => void;
  /**
   * Hide write-affording menu items (Mark-as-read/unread, Analyze) when
   * the conversation is read-only. Items are hidden entirely, not
   * disabled. Today this fires for channel-bound conversations (Slack,
   * Telegram, voice) where outbound writes aren't mirrored back to the
   * source channel; future read-only sources (e.g. daemon-side locks
   * per ATL-543) can feed the same gate.
   *
   * Archive/Unarchive intentionally stay available even when read-only
   * — moving a thread out of the active sidebar is an organizational
   * action that doesn't write to the source channel, and channel
   * conversations accumulate faster than native ones so users need
   * to be able to tidy them up. Mirrors the macOS consumer-side
   * `isReadonly` flag.
   */
  isReadonly?: boolean;
  /** Trigger an analysis of this conversation via the daemon. */
  onAnalyze?: () => void;
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
   * decisions per message. Web counterpart of macOS's per-bubble
   * "Inspect LLM context" item (gated there by the
   * `settings-developer-nav` flag); on web it's surfaced via the
   * conversation menu instead.
   */
  onInspect?: () => void;
  /** Copy the full conversation as markdown to the clipboard. */
  onCopyConversation?: () => void;
  /** Re-fetch the chat context and reload the current conversation. */
  onRefresh?: () => void;
  /** Controls item order and labels. "header" uses macOS-parity order; "sidebar" preserves the original order. */
  variant?: "header" | "sidebar";
}

/**
 * Render the conversation row's menu items into either a `Menu` or a
 * `ContextMenu`. Both namespaces expose the same `Item / Separator / Sub /
 * SubTrigger / SubContent` shape; passing one in via `Primitive` keeps the
 * dropdown trigger and the right-click context menu in lockstep without
 * duplicating the item list.
 */
export function renderConversationMenuItems({
  Primitive,
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  moveToGroups,
  onMoveToGroup,
  onRemoveFromGroup,
  isReadonly = false,
  onAnalyze,
  onForkConversation,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onCopyConversation,
  onRefresh,
  variant = "sidebar",
}: ConversationMenuItemsProps & {
  Primitive: ConversationMenuPrimitive;
}): ReactNode {
  const showMoveToGroup =
    onMoveToGroup && moveToGroups && moveToGroups.length > 0;

  const pinItem = onPinToggle ? (
    <Primitive.Item
      leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
      onSelect={onPinToggle}
    >
      {isPinned ? "Unpin" : "Pin"}
    </Primitive.Item>
  ) : null;

  const renameItem = onRename ? (
    <Primitive.Item leftIcon={<Pencil size={14} />} onSelect={onRename}>
      Rename
    </Primitive.Item>
  ) : null;

  const archiveItem =
    isArchived && onUnarchive ? (
      <Primitive.Item
        leftIcon={<ArchiveRestore size={14} />}
        onSelect={onUnarchive}
      >
        Unarchive
      </Primitive.Item>
    ) : onArchive ? (
      <Primitive.Item leftIcon={<Archive size={14} />} onSelect={onArchive}>
        Archive
      </Primitive.Item>
    ) : null;

  const markReadUnreadItem =
    !isReadonly && onMarkRead ? (
      <Primitive.Item
        leftIcon={<CircleCheck size={14} />}
        onSelect={onMarkRead}
      >
        Mark as read
      </Primitive.Item>
    ) : !isReadonly && onMarkUnread ? (
      <Primitive.Item
        leftIcon={<Circle size={14} />}
        onSelect={onMarkUnread}
        disabled={isMarkUnreadDisabled}
      >
        Mark as unread
      </Primitive.Item>
    ) : null;

  const moveToGroupItem = showMoveToGroup ? (
    <Primitive.Sub>
      <Primitive.SubTrigger leftIcon={<FolderInput size={14} />}>
        Move to
      </Primitive.SubTrigger>
      <Primitive.SubContent>
        {moveToGroups.map((group) => (
          <Primitive.Item
            key={group.id}
            onSelect={() => onMoveToGroup(group.id)}
          >
            {group.name}
          </Primitive.Item>
        ))}
        {onRemoveFromGroup ? (
          <>
            <Primitive.Separator />
            <Primitive.Item onSelect={onRemoveFromGroup}>
              Remove from group
            </Primitive.Item>
          </>
        ) : null}
      </Primitive.SubContent>
    </Primitive.Sub>
  ) : null;

  const analyzeItem =
    !isReadonly && onAnalyze ? (
      <Primitive.Item leftIcon={<Sparkles size={14} />} onSelect={onAnalyze}>
        {variant === "header" ? "Analyze conversation" : "Analyze"}
      </Primitive.Item>
    ) : null;

  const openInNewWindowItem = onOpenInNewWindow ? (
    <Primitive.Item
      leftIcon={<ExternalLink size={14} />}
      onSelect={onOpenInNewWindow}
    >
      {variant === "header" ? "Open in new window" : "Open in New Window"}
    </Primitive.Item>
  ) : null;

  const inspectItem = onInspect ? (
    <Primitive.Item leftIcon={<Microscope size={14} />} onSelect={onInspect}>
      Inspect
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
            Copy full conversation
          </Primitive.Item>
        ) : null}

        {onForkConversation ? (
          <Primitive.Item
            leftIcon={<GitBranch size={14} />}
            onSelect={onForkConversation}
          >
            Fork conversation
          </Primitive.Item>
        ) : null}

        {analyzeItem}
        {openInNewWindowItem}

        {onRefresh ? (
          <Primitive.Item
            leftIcon={<RefreshCw size={14} />}
            onSelect={onRefresh}
          >
            Refresh
          </Primitive.Item>
        ) : null}

        {pinItem}
        {renameItem}
        {archiveItem}
        {inspectItem}
      </>
    );
  }

  return (
    <>
      {pinItem}
      {renameItem}
      {archiveItem}

      {markReadUnreadItem}
      {analyzeItem}
      {moveToGroupItem}
      {openInNewWindowItem}

      {onShareFeedback ? (
        <>
          <Primitive.Separator />
          <Primitive.Item
            leftIcon={<MessageCircle size={14} />}
            onSelect={onShareFeedback}
          >
            Share Feedback
          </Primitive.Item>
        </>
      ) : null}

      {inspectItem ? (
        <>
          <Primitive.Separator />
          {inspectItem}
        </>
      ) : null}
    </>
  );
}

/**
 * 1px divider for the mobile bottom-sheet menu. Mirrors the in-popover
 * separator style used elsewhere in the app — `var(--border-overlay)` so
 * it reads as a section break inside `--surface-lift` chrome.
 */
function MobileMenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="my-1 h-px"
      style={{ background: "var(--border-overlay)" }}
    />
  );
}

/**
 * Build a single menu row for the mobile bottom sheet. We render a
 * `PanelItem` so the row matches the design system spec (surface tokens,
 * 32px height, hover/active states) and so the implementation only knows
 * about one row primitive. The `onSelect` handler runs first, then the
 * sheet dismisses via `onClose` so the action's UI feedback (modals,
 * toasts, navigation) doesn't fire under a still-open sheet.
 */
function buildPanelItem({
  key,
  icon,
  label,
  disabled,
  className,
  run,
  onClose,
}: {
  key: string;
  /** Optional leading icon. Omit for sub-items rendered under a section label. */
  icon?: LucideIcon;
  label: string;
  disabled?: boolean;
  className?: string;
  run: () => void;
  onClose: () => void;
}): ReactNode {
  const composedClassName = [
    disabled ? "pointer-events-none opacity-50" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <PanelItem
      key={key}
      icon={icon}
      label={label}
      onSelect={
        disabled
          ? undefined
          : () => {
              run();
              onClose();
            }
      }
      aria-disabled={disabled || undefined}
      className={composedClassName || undefined}
    />
  );
}

/**
 * Mobile-only renderer for the bottom-sheet surface. Returns the same
 * conceptual item set as `renderConversationMenuItems` but flattened into
 * `PanelItem` rows, with the "Move to" submenu rendered inline under a
 * label since `BottomSheet` is a single-level surface.
 *
 * Each handler dismisses the sheet via `onClose` after firing so the
 * follow-up UI (rename modal, archive toast, navigation) lands on the
 * collapsed surface.
 */
function renderConversationMenuItemsAsPanelItems({
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  moveToGroups,
  onMoveToGroup,
  onRemoveFromGroup,
  isReadonly = false,
  onAnalyze,
  onForkConversation,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onCopyConversation,
  onRefresh,
  variant = "sidebar",
  onClose,
}: ConversationMenuItemsProps & { onClose: () => void }): ReactNode {
  const showMoveToGroup =
    onMoveToGroup && moveToGroups && moveToGroups.length > 0;

  const pinItem = onPinToggle
    ? buildPanelItem({
        key: "pin",
        icon: isPinned ? PinOff : Pin,
        label: isPinned ? "Unpin" : "Pin",
        run: onPinToggle,
        onClose,
      })
    : null;

  const renameItem = onRename
    ? buildPanelItem({
        key: "rename",
        icon: Pencil,
        label: "Rename",
        run: onRename,
        onClose,
      })
    : null;

  const archiveItem =
    isArchived && onUnarchive
      ? buildPanelItem({
          key: "unarchive",
          icon: ArchiveRestore,
          label: "Unarchive",
          run: onUnarchive,
          onClose,
        })
      : onArchive
        ? buildPanelItem({
            key: "archive",
            icon: Archive,
            label: "Archive",
            run: onArchive,
            onClose,
          })
        : null;

  const markReadUnreadItem =
    !isReadonly && onMarkRead
      ? buildPanelItem({
          key: "mark-read",
          icon: CircleCheck,
          label: "Mark as read",
          run: onMarkRead,
          onClose,
        })
      : !isReadonly && onMarkUnread
        ? buildPanelItem({
            key: "mark-unread",
            icon: Circle,
            label: "Mark as unread",
            disabled: isMarkUnreadDisabled,
            run: onMarkUnread,
            onClose,
          })
        : null;

  const analyzeItem =
    !isReadonly && onAnalyze
      ? buildPanelItem({
          key: "analyze",
          icon: Sparkles,
          label: variant === "header" ? "Analyze conversation" : "Analyze",
          run: onAnalyze,
          onClose,
        })
      : null;

  const openInNewWindowItem = onOpenInNewWindow
    ? buildPanelItem({
        key: "open-in-new-window",
        icon: ExternalLink,
        label:
          variant === "header" ? "Open in new window" : "Open in New Window",
        run: onOpenInNewWindow,
        onClose,
      })
    : null;

  const inspectItem = onInspect
    ? buildPanelItem({
        key: "inspect",
        icon: Microscope,
        label: "Inspect",
        run: onInspect,
        onClose,
      })
    : null;

  // "Move to" submenu — flattened into the single-level sheet under a small
  // section label. This matches the macOS mobile design where submenus open
  // as their own slide-up sheet, but a label-prefixed inline list is the
  // simpler equivalent that keeps the action surface a single tap away.
  // Group rows omit the leading icon so the section label does the visual
  // grouping work (avoids a column of identical FolderInput glyphs).
  const moveToGroupBlock = showMoveToGroup ? (
    <>
      <MobileMenuDivider />
      <div className="flex items-center gap-2 px-2 pt-1 pb-1 text-body-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
        <FolderInput size={14} aria-hidden />
        Move to
      </div>
      {moveToGroups.map((group) =>
        buildPanelItem({
          key: `move-to-${group.id}`,
          label: group.name,
          // Indent in lieu of the leading icon so the rows read as
          // sub-items of the "Move to" section above.
          className: "pl-7",
          run: () => onMoveToGroup(group.id),
          onClose,
        }),
      )}
      {onRemoveFromGroup
        ? buildPanelItem({
            key: "remove-from-group",
            label: "Remove from group",
            className: "pl-7",
            run: onRemoveFromGroup,
            onClose,
          })
        : null}
    </>
  ) : null;

  if (variant === "header") {
    return (
      <>
        {onCopyConversation
          ? buildPanelItem({
              key: "copy",
              icon: Copy,
              label: "Copy full conversation",
              run: onCopyConversation,
              onClose,
            })
          : null}

        {onForkConversation
          ? buildPanelItem({
              key: "fork",
              icon: GitBranch,
              label: "Fork conversation",
              run: onForkConversation,
              onClose,
            })
          : null}

        {analyzeItem}
        {openInNewWindowItem}

        {onRefresh
          ? buildPanelItem({
              key: "refresh",
              icon: RefreshCw,
              label: "Refresh",
              run: onRefresh,
              onClose,
            })
          : null}

        {pinItem}
        {renameItem}
        {archiveItem}
        {inspectItem}
      </>
    );
  }

  return (
    <>
      {pinItem}
      {renameItem}
      {archiveItem}
      {markReadUnreadItem}
      {analyzeItem}
      {moveToGroupBlock}
      {openInNewWindowItem}

      {onShareFeedback ? (
        <>
          <MobileMenuDivider />
          {buildPanelItem({
            key: "share-feedback",
            icon: MessageCircle,
            label: "Share Feedback",
            run: onShareFeedback,
            onClose,
          })}
        </>
      ) : null}

      {inspectItem ? (
        <>
          <MobileMenuDivider />
          {inspectItem}
        </>
      ) : null}
    </>
  );
}

export interface ConversationActionsMenuProps extends ConversationMenuItemsProps {
  /**
   * Override the default hover-revealed ellipsis button with a custom
   * trigger (e.g. the topbar thread-name dropdown). The element is
   * wrapped in Radix `Menu.Trigger asChild`, so it must be a
   * native button/anchor or a `forwardRef` component.
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
  const isMobile = useIsMobile();
  // Lift open state so the mobile bottom-sheet branch can dismiss after a
  // selection. The desktop `Menu.Root` is happy to be controlled too — Radix
  // honors `open`/`onOpenChange` for both surfaces, so a single state hook
  // serves both branches.
  const [open, setOpen] = useState(false);

  const defaultTrigger = (
    <span
      role="button"
      tabIndex={0}
      aria-label="Conversation actions"
      aria-haspopup="menu"
      // Stop propagation so clicking the ellipsis doesn't also fire
      // the row's onSelect (which would switch to the conversation).
      onClick={(event) => event.stopPropagation()}
      // Stop the row's right-click context menu from opening when the
      // user right-clicks the ellipsis itself — the dropdown is the
      // canonical surface for this trigger. Also prevent the browser's
      // native context menu so we don't surface a second menu where the
      // rest of the row would suppress it.
      onContextMenu={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      // <span> doesn't natively fire click on Enter/Space like <button>,
      // so synthesize it for keyboard accessibility.
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          (event.currentTarget as HTMLElement).click();
        }
      }}
      // Force the button visible while the menu is open; otherwise
      // it would disappear the moment the mouse leaves the row as the
      // user tracks toward a menu item.
      className="flex h-6 w-6 items-center justify-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
    >
      <MoreHorizontal size={14} aria-hidden />
    </span>
  );

  const resolvedTrigger = trigger ?? defaultTrigger;

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{resolvedTrigger}</BottomSheet.Trigger>
        {/*
          Radix Dialog requires a Title for accessibility. The visible
          title would duplicate the conversation header above the sheet,
          so we render an `sr-only` Header containing the Title — the
          same pattern documented in `BottomSheet.gallery.tsx`. The
          `aria-describedby={undefined}` opt-out silences the matching
          Description recommendation (the menu items themselves describe
          what the sheet is for).
        */}
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Conversation actions</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {renderConversationMenuItemsAsPanelItems({
              ...itemProps,
              onClose: () => setOpen(false),
            })}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>{resolvedTrigger}</Menu.Trigger>
      <Menu.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        // React portal events bubble through the component tree, not the DOM tree.
        // Without this, clicking a menu item also triggers PanelItem's onSelect.
        onClick={(event) => event.stopPropagation()}
      >
        {renderConversationMenuItems({ Primitive: Menu, ...itemProps })}
      </Menu.Content>
    </Menu.Root>
  );
}
