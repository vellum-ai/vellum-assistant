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
// Shared group menu items — used by both the hover popover and the
// right-click context menu so both surfaces stay in lockstep.
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

// ---------------------------------------------------------------------------
// GroupActionsMenu — rename/delete context menu for custom group headers
// ---------------------------------------------------------------------------

interface GroupActionsMenuProps {
  groupId: string;
  onRename?: (groupId: string) => void;
  onDelete?: (groupId: string) => void;
}

export function GroupActionsMenu({ groupId, onRename, onDelete }: GroupActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const closeMenu = () => setOpen(false);

  const trigger = (
    <button
      type="button"
      aria-label="Group actions"
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
            <BottomSheet.Title>Group actions</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {onRename ? (
              <PanelItem
                icon={Pencil}
                label="Rename"
                onSelect={() => {
                  closeMenu();
                  onRename(groupId);
                }}
              />
            ) : null}
            {onDelete ? (
              <PanelItem
                icon={Trash2}
                label="Delete"
                onSelect={() => {
                  closeMenu();
                  onDelete(groupId);
                }}
              />
            ) : null}
          </BottomSheet.Body>
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
        className="w-40 rounded-lg py-2 px-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-2">
          {onRename ? (
            <PanelItem
              icon={Pencil}
              label="Rename"
              onSelect={() => {
                closeMenu();
                onRename(groupId);
              }}
            />
          ) : null}
          {onDelete ? (
            <PanelItem
              icon={Trash2}
              label="Delete"
              onSelect={() => {
                closeMenu();
                onDelete(groupId);
              }}
            />
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
