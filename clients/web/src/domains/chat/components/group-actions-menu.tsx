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
 * Mirrors the same split used by `conversation-actions-menu.tsx` for the
 * per-conversation menu (`renderConversationMenuItems` /
 * `renderConversationMenuItemsAsPanelItems`).
 */

import {
    Archive,
    CircleCheck,
    MoreHorizontal,
    Pencil,
    Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
    BottomSheet,
    ContextMenu,
    Menu,
    PanelItem,
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
}: GroupMenuItemsProps): boolean {
  return (
    onMarkAllRead != null ||
    onArchiveAll != null ||
    onRename != null ||
    onDelete != null
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
}: GroupMenuItemsProps & { Primitive: GroupMenuPrimitive }): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions = onRename != null || onDelete != null;

  return (
    <>
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
    </>
  );
}

/**
 * 1px divider for the PanelItem surfaces. Mirrors the in-popover separator
 * style used elsewhere in the app.
 */
function PanelMenuDivider() {
  return (
    <div aria-hidden="true" className="my-1 h-px bg-[var(--border-overlay)]" />
  );
}

/**
 * Build a single PanelItem row. The `run` handler fires first, then the
 * surface dismisses via `onClose`, so the action's own UI feedback (dialogs,
 * toasts) doesn't appear under a still-open sheet.
 *
 * `PanelItem` has no disabled prop, so a disabled row drops its `onSelect`
 * and is styled/announced as disabled instead.
 */
function buildGroupPanelItem({
  key,
  icon,
  label,
  disabled,
  run,
  onClose,
}: {
  key: string;
  icon: typeof Pencil;
  label: string;
  disabled?: boolean;
  run: () => void;
  onClose: () => void;
}): ReactNode {
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
      className={disabled ? "pointer-events-none opacity-50" : undefined}
    />
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
  onClose,
}: GroupMenuItemsProps & { onClose: () => void }): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions = onRename != null || onDelete != null;

  return (
    <>
      {onMarkAllRead
        ? buildGroupPanelItem({
            key: "mark-all-read",
            icon: CircleCheck,
            label: "Mark All as Read",
            disabled: !hasUnreadConversations,
            run: onMarkAllRead,
            onClose,
          })
        : null}
      {onArchiveAll
        ? buildGroupPanelItem({
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
        ? buildGroupPanelItem({
            key: "rename",
            icon: Pencil,
            label: "Rename",
            run: onRename,
            onClose,
          })
        : null}
      {onDelete
        ? buildGroupPanelItem({
            key: "delete",
            icon: Trash2,
            label: hasConversations ? "Delete group…" : "Delete group",
            run: onDelete,
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
  label?: string;
}

/**
 * Trailing "…" affordance on a custom-group header. Renders the shared group
 * menu items, so this menu and the header's right-click menu always offer the
 * same actions.
 */
export function GroupActionsMenu({ label, ...menuProps }: GroupActionsMenuProps) {
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
      aria-label={label ? `${label} actions` : "Group actions"}
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
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{label ?? "Group"} actions</BottomSheet.Title>
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
