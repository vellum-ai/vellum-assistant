import {
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import {
  BottomSheet,
  PanelItem,
  Popover,
} from "@vellum/design-library";
import { useIsMobile } from "@/hooks/use-is-mobile";

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
