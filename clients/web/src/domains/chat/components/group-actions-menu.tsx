/**
 * Section-header ("group") actions — the bulk menu shared by every sidebar
 * section: Pinned, Chats, each origin-channel section, and each custom group.
 *
 * One prop shape ({@link GroupMenuItemsProps}) feeds three surfaces so they
 * can't drift:
 *
 * - {@link renderGroupMenuItems} — Radix `ContextMenu` / `Menu` items, used
 *   for the desktop right-click menu on a section header.
 * - {@link renderGroupMenuItemsAsPanelItems} — the same item set flattened
 *   into `PanelItem` rows for the popover and the mobile bottom sheet.
 * - {@link GroupActionsMenu} — the trailing "…" button on custom-group
 *   headers, which renders the PanelItem set in a Popover (desktop) or a
 *   BottomSheet (mobile).
 *
 * `conversation-actions-menu.tsx` splits the per-conversation menu the same
 * way; the `PanelItem` row primitives both use live in `panel-menu-item.tsx`.
 */

import {
    Archive,
    ArrowDown,
    ArrowUp,
    CircleCheck,
    Copy,
    MoreHorizontal,
    Pencil,
    Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  buildPanelMenuItem,
  PanelMenuDivider,
} from "@/domains/chat/components/panel-menu-item";
import {
  BottomSheet,
  ContextMenu,
  Menu,
  Popover,
} from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// Shared group menu items — used by the hover popover, the right-click
// context menu, and the mobile long-press sheet so all three stay in lockstep.
// ---------------------------------------------------------------------------

export type GroupMenuPrimitive = {
  Item: typeof Menu.Item | typeof ContextMenu.Item;
  Separator: typeof Menu.Separator | typeof ContextMenu.Separator;
};

export interface GroupMenuItemsProps {
  onMarkAllRead?: () => void;
  hasUnreadConversations?: boolean;
  onArchiveAll?: () => void;
  hasConversations?: boolean;
  onRename?: () => void;
  onDelete?: () => void;
  /**
   * Copy the group's id to the clipboard. Lets users paste a precise
   * reference into chat (the assistant resolves group ids directly).
   */
  onCopyGroupId?: () => void;
  /**
   * Move this section one slot up / down in the sidebar. Omitted when the
   * section is already at that end, which is also why they're separate
   * optional callbacks rather than one `onMove(delta)`: absence *is* the
   * disabled state, so the menu never offers a move that does nothing.
   *
   * These are the pointer-free path to the same reordering the header's
   * drag handle performs - HTML5 drag events fire on neither touch nor the
   * keyboard, so without them section layout would be mouse-only.
   */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/**
 * True when at least one action is wired. Callers use this to skip mounting
 * the menu surface entirely rather than opening an empty popover.
 */
export function hasAnyGroupMenuAction({
  onMarkAllRead,
  onArchiveAll,
  onRename,
  onDelete,
  onCopyGroupId,
  onMoveUp,
  onMoveDown,
}: GroupMenuItemsProps): boolean {
  return (
    onMarkAllRead != null ||
    onArchiveAll != null ||
    onRename != null ||
    onDelete != null ||
    onCopyGroupId != null ||
    onMoveUp != null ||
    onMoveDown != null
  );
}

export function renderGroupMenuItems({
  Primitive,
  onMarkAllRead,
  hasUnreadConversations = false,
  onArchiveAll,
  hasConversations = false,
  onRename,
  onDelete,
  onCopyGroupId,
  onMoveUp,
  onMoveDown,
}: GroupMenuItemsProps & { Primitive: GroupMenuPrimitive }): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions =
    onRename != null || onDelete != null || onCopyGroupId != null;
  const hasMoveActions = onMoveUp != null || onMoveDown != null;

  return (
    <>
      {/* Layout actions lead: they apply to every section, so keeping them
          in one place means the menu doesn't reshuffle between a channel
          section (no rename/delete) and a custom group. */}
      {onMoveUp ? (
        <Primitive.Item leftIcon={<ArrowUp size={14} />} onSelect={onMoveUp}>
          Move Section Up
        </Primitive.Item>
      ) : null}
      {onMoveDown ? (
        <Primitive.Item leftIcon={<ArrowDown size={14} />} onSelect={onMoveDown}>
          Move Section Down
        </Primitive.Item>
      ) : null}
      {hasMoveActions && (hasBulkActions || hasIndividualActions) ? (
        <Primitive.Separator />
      ) : null}
      {onMarkAllRead ? (
        <Primitive.Item
          leftIcon={<CircleCheck size={14} />}
          onSelect={onMarkAllRead}
          disabled={!hasUnreadConversations}
        >
          Mark All as Read
        </Primitive.Item>
      ) : null}
      {onArchiveAll ? (
        <Primitive.Item
          leftIcon={<Archive size={14} />}
          onSelect={onArchiveAll}
          disabled={!hasConversations}
        >
          Archive All…
        </Primitive.Item>
      ) : null}
      {hasBulkActions && hasIndividualActions ? <Primitive.Separator /> : null}
      {onRename ? (
        <Primitive.Item leftIcon={<Pencil size={14} />} onSelect={onRename}>
          Rename
        </Primitive.Item>
      ) : null}
      {onDelete ? (
        <Primitive.Item leftIcon={<Trash2 size={14} />} onSelect={onDelete}>
          {hasConversations ? "Delete group…" : "Delete group"}
        </Primitive.Item>
      ) : null}
      {onCopyGroupId ? (
        <Primitive.Item leftIcon={<Copy size={14} />} onSelect={onCopyGroupId}>
          Copy group ID
        </Primitive.Item>
      ) : null}
    </>
  );
}

/**
 * Popover / bottom-sheet renderer. Returns the same conceptual item set as
 * {@link renderGroupMenuItems}, flattened into `PanelItem` rows.
 */
export function renderGroupMenuItemsAsPanelItems({
  onMarkAllRead,
  hasUnreadConversations = false,
  onArchiveAll,
  hasConversations = false,
  onRename,
  onDelete,
  onCopyGroupId,
  onMoveUp,
  onMoveDown,
  onClose,
}: GroupMenuItemsProps & { onClose: () => void }): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions =
    onRename != null || onDelete != null || onCopyGroupId != null;
  const hasMoveActions = onMoveUp != null || onMoveDown != null;

  return (
    <>
      {onMoveUp
        ? buildPanelMenuItem({
            key: "move-section-up",
            icon: ArrowUp,
            label: "Move Section Up",
            run: onMoveUp,
            onClose,
          })
        : null}
      {onMoveDown
        ? buildPanelMenuItem({
            key: "move-section-down",
            icon: ArrowDown,
            label: "Move Section Down",
            run: onMoveDown,
            onClose,
          })
        : null}
      {hasMoveActions && (hasBulkActions || hasIndividualActions) ? (
        <PanelMenuDivider />
      ) : null}
      {onMarkAllRead
        ? buildPanelMenuItem({
            key: "mark-all-read",
            icon: CircleCheck,
            label: "Mark All as Read",
            disabled: !hasUnreadConversations,
            run: onMarkAllRead,
            onClose,
          })
        : null}
      {onArchiveAll
        ? buildPanelMenuItem({
            key: "archive-all",
            icon: Archive,
            label: "Archive All…",
            disabled: !hasConversations,
            run: onArchiveAll,
            onClose,
          })
        : null}
      {hasBulkActions && hasIndividualActions ? <PanelMenuDivider /> : null}
      {onRename
        ? buildPanelMenuItem({
            key: "rename",
            icon: Pencil,
            label: "Rename",
            run: onRename,
            onClose,
          })
        : null}
      {onDelete
        ? buildPanelMenuItem({
            key: "delete",
            icon: Trash2,
            label: hasConversations ? "Delete group…" : "Delete group",
            run: onDelete,
            onClose,
          })
        : null}
      {onCopyGroupId
        ? buildPanelMenuItem({
            key: "copy-group-id",
            icon: Copy,
            label: "Copy group ID",
            run: onCopyGroupId,
            onClose,
          })
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// GroupActionsMenu — the trailing "…" button on a custom group header
// ---------------------------------------------------------------------------

export interface GroupActionsMenuProps extends GroupMenuItemsProps {
  /** Group name, used for the trigger's accessible label. */
  label: string;
}

/**
 * Trailing "…" affordance on a custom-group header. Renders the shared group
 * menu items, so this menu and the header's right-click menu always offer the
 * same actions.
 */
export function GroupActionsMenu({
  label,
  ...menuProps
}: GroupActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const closeMenu = () => setOpen(false);

  if (!hasAnyGroupMenuAction(menuProps)) {
    return null;
  }

  const items = renderGroupMenuItemsAsPanelItems({
    ...menuProps,
    onClose: closeMenu,
  });

  const trigger = (
    <button
      type="button"
      aria-label={`${label} actions`}
      aria-haspopup="menu"
      onClick={(event) => event.stopPropagation()}
      className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
    >
      <MoreHorizontal size={14} aria-hidden />
    </button>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{label} actions</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{items}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content
        side="right"
        align="start"
        sideOffset={4}
        className="w-48 rounded-lg py-2 px-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-2">{items}</div>
      </Popover.Content>
    </Popover.Root>
  );
}
