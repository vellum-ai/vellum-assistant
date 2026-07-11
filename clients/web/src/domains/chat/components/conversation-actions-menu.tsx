import {
  Archive,
  ArchiveRestore,
  Circle,
  CircleCheck,
  Copy,
  ExternalLink,
  GitBranch,
  MessageCircle,
  Microscope,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  BottomSheet,
  ContextMenu,
  Menu,
  PanelItem,
} from "@vellumai/design-library";

/**
 * Hover-revealed "more" menu for a conversation row. Renders an ellipsis
 * button; clicking it opens a dropdown menu with Pin / Rename / Archive /
 * Mark as unread actions.
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
  /** Re-fetch the chat context and reload the current conversation. */
  onRefresh?: () => void;
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
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  isReadonly = false,
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
 * separator style used elsewhere in the app.
 */
function MobileMenuDivider() {
  return (
    <div aria-hidden="true" className="my-1 h-px bg-[var(--border-overlay)]" />
  );
}

/**
 * Build a single menu row for the mobile bottom sheet. Renders a
 * `PanelItem` so the row matches the design system spec. The `onSelect`
 * handler runs first, then the sheet dismisses via `onClose` so the
 * action's UI feedback (modals, toasts, navigation) doesn't fire under
 * a still-open sheet.
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
 * `PanelItem` rows.
 */
export function renderConversationMenuItemsAsPanelItems({
  isPinned = false,
  isArchived = false,
  onPinToggle,
  onRename,
  onArchive,
  onUnarchive,
  onMarkUnread,
  isMarkUnreadDisabled = false,
  onMarkRead,
  isReadonly = false,
  onForkConversation,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onCopyConversation,
  onRefresh,
  variant = "sidebar",
  onClose,
  isNativePlatform = false,
}: ConversationMenuItemsProps & {
  onClose: () => void;
  isNativePlatform?: boolean;
}): ReactNode {
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

  const openInNewWindowItem =
    onOpenInNewWindow && !isNativePlatform
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
  return (
    <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
      ) : null}
      <BottomSheet.Content aria-describedby={undefined}>
        <BottomSheet.Header className="sr-only">
          <BottomSheet.Title>Conversation actions</BottomSheet.Title>
        </BottomSheet.Header>
        <BottomSheet.Body className="pt-0">
          {renderConversationMenuItemsAsPanelItems({
            ...itemProps,
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
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const defaultTrigger = (
    <button
      type="button"
      aria-label="Conversation actions"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
    >
      <MoreHorizontal size={14} aria-hidden />
    </button>
  );

  const resolvedTrigger = trigger ?? defaultTrigger;

  if (isMobile) {
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
        {renderConversationMenuItems({ Primitive: Menu, ...itemProps })}
      </Menu.Content>
    </Menu.Root>
  );
}
