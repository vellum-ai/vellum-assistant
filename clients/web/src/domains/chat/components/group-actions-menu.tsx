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
 *   into `PanelItem` rows for the popover and the touch bottom sheet.
 * - {@link GroupActionsMenu} — the trailing "…" button on a section header,
 *   which renders the PanelItem set in a Popover (desktop) or a BottomSheet
 *   (mobile). Every section carries one, so a section's actions never depend
 *   on the user knowing to right-click.
 *
 * `conversation-actions-menu.tsx` splits the per-conversation menu the same
 * way; the `PanelItem` row primitives both use live in `panel-menu-item.tsx`.
 */

import {
  Archive,
  ArrowDown,
  ArrowUp,
  Copy,
  Layers,
  Pencil,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation, type TFunction } from "@/i18n";
import { SectionActionsButton } from "@/components/section-actions-button";
import {
  buildPanelMenuItem,
  PanelMenuDivider,
} from "@/domains/chat/components/panel-menu-item";
import { MARK_ALL_READ_ICON } from "@/utils/read-state-icon";
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
  /**
   * Switch the sidebar between one flat chat list and one section per origin
   * channel. Offered by the sections the switch actually changes (Chats and
   * the channel sections), which is why it sits beside their bulk actions
   * rather than in a sidebar-wide header: the section carrying the toggle is
   * the section it reshapes.
   */
  onToggleGroupByChannel?: () => void;
  /** Whether channel grouping is on, which decides the toggle's label. */
  isGroupedByChannel?: boolean;
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
  onToggleGroupByChannel,
  onMoveUp,
  onMoveDown,
}: GroupMenuItemsProps): boolean {
  return (
    onMarkAllRead != null ||
    onArchiveAll != null ||
    onRename != null ||
    onDelete != null ||
    onCopyGroupId != null ||
    onToggleGroupByChannel != null ||
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
  onToggleGroupByChannel,
  isGroupedByChannel = false,
  onMoveUp,
  onMoveDown,
  t,
}: GroupMenuItemsProps & {
  Primitive: GroupMenuPrimitive;
  t: TFunction<"chat">;
}): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions =
    onRename != null ||
    onDelete != null ||
    onCopyGroupId != null ||
    onToggleGroupByChannel != null;
  const hasMoveActions = onMoveUp != null || onMoveDown != null;

  return (
    <>
      {/* Layout actions lead: they apply to every section, so keeping them
          in one place means the menu doesn't reshuffle between a channel
          section (no rename/delete) and a custom group. */}
      {onMoveUp ? (
        <Primitive.Item leftIcon={<ArrowUp size={14} />} onSelect={onMoveUp}>
          {t("groupActions.moveSectionUp")}
        </Primitive.Item>
      ) : null}
      {onMoveDown ? (
        <Primitive.Item
          leftIcon={<ArrowDown size={14} />}
          onSelect={onMoveDown}
        >
          {t("groupActions.moveSectionDown")}
        </Primitive.Item>
      ) : null}
      {hasMoveActions && (hasBulkActions || hasIndividualActions) ? (
        <Primitive.Separator />
      ) : null}
      {onMarkAllRead ? (
        <Primitive.Item
          leftIcon={<MARK_ALL_READ_ICON size={14} />}
          onSelect={onMarkAllRead}
          disabled={!hasUnreadConversations}
        >
          {t("groupActions.markAllRead")}
        </Primitive.Item>
      ) : null}
      {onArchiveAll ? (
        <Primitive.Item
          leftIcon={<Archive size={14} />}
          onSelect={onArchiveAll}
          disabled={!hasConversations}
        >
          {t("groupActions.archiveAll")}
        </Primitive.Item>
      ) : null}
      {hasBulkActions && hasIndividualActions ? <Primitive.Separator /> : null}
      {onRename ? (
        <Primitive.Item leftIcon={<Pencil size={14} />} onSelect={onRename}>
          {t("groupActions.rename")}
        </Primitive.Item>
      ) : null}
      {onDelete ? (
        <Primitive.Item leftIcon={<Trash2 size={14} />} onSelect={onDelete}>
          {hasConversations
            ? t("groupActions.deleteGroupWithConversations")
            : t("groupActions.deleteGroup")}
        </Primitive.Item>
      ) : null}
      {onCopyGroupId ? (
        <Primitive.Item leftIcon={<Copy size={14} />} onSelect={onCopyGroupId}>
          {t("groupActions.copyGroupId")}
        </Primitive.Item>
      ) : null}
      {onToggleGroupByChannel ? (
        <Primitive.Item
          leftIcon={<Layers size={14} />}
          onSelect={onToggleGroupByChannel}
        >
          {isGroupedByChannel
            ? t("groupActions.ungroup")
            : t("groupActions.groupByChannel")}
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
  onToggleGroupByChannel,
  isGroupedByChannel = false,
  onMoveUp,
  onMoveDown,
  onClose,
  t,
}: GroupMenuItemsProps & {
  onClose: () => void;
  t: TFunction<"chat">;
}): ReactNode {
  const hasBulkActions = onMarkAllRead != null || onArchiveAll != null;
  const hasIndividualActions =
    onRename != null ||
    onDelete != null ||
    onCopyGroupId != null ||
    onToggleGroupByChannel != null;
  const hasMoveActions = onMoveUp != null || onMoveDown != null;

  return (
    <>
      {onMoveUp
        ? buildPanelMenuItem({
            key: "move-section-up",
            icon: ArrowUp,
            label: t("groupActions.moveSectionUp"),
            run: onMoveUp,
            onClose,
          })
        : null}
      {onMoveDown
        ? buildPanelMenuItem({
            key: "move-section-down",
            icon: ArrowDown,
            label: t("groupActions.moveSectionDown"),
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
            icon: MARK_ALL_READ_ICON,
            label: t("groupActions.markAllRead"),
            disabled: !hasUnreadConversations,
            run: onMarkAllRead,
            onClose,
          })
        : null}
      {onArchiveAll
        ? buildPanelMenuItem({
            key: "archive-all",
            icon: Archive,
            label: t("groupActions.archiveAll"),
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
            label: t("groupActions.rename"),
            run: onRename,
            onClose,
          })
        : null}
      {onDelete
        ? buildPanelMenuItem({
            key: "delete",
            icon: Trash2,
            label: hasConversations
              ? t("groupActions.deleteGroupWithConversations")
              : t("groupActions.deleteGroup"),
            run: onDelete,
            onClose,
          })
        : null}
      {onCopyGroupId
        ? buildPanelMenuItem({
            key: "copy-group-id",
            icon: Copy,
            label: t("groupActions.copyGroupId"),
            run: onCopyGroupId,
            onClose,
          })
        : null}
      {onToggleGroupByChannel
        ? buildPanelMenuItem({
            key: "toggle-group-by-channel",
            icon: Layers,
            label: isGroupedByChannel
              ? t("groupActions.ungroup")
              : t("groupActions.groupByChannel"),
            run: onToggleGroupByChannel,
            onClose,
          })
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// GroupActionsMenu — the trailing "…" button on a section header
// ---------------------------------------------------------------------------

export interface GroupActionsMenuProps extends GroupMenuItemsProps {
  /** Group name, used for the trigger's accessible label. */
  label: string;
}

/**
 * Trailing "…" affordance on a section header. Renders the shared group menu
 * items, so this menu, the header's right-click menu and the mobile long-press
 * sheet always offer the same actions - the reachability the sidebar's grouping
 * toggle depends on (LUM-3120).
 */
export function GroupActionsMenu({
  label,
  ...menuProps
}: GroupActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const isTouchMobile = useTouchMobile();
  const { t } = useTranslation("chat");
  const closeMenu = () => setOpen(false);
  const hasItems = hasAnyGroupMenuAction(menuProps);

  if (!hasItems) {
    return null;
  }

  const items = renderGroupMenuItemsAsPanelItems({
    ...menuProps,
    onClose: closeMenu,
    t,
  });

  const trigger = <SectionActionsButton label={label} />;

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>
              {t("groupActionsSheet.title", { name: label })}
            </BottomSheet.Title>
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
