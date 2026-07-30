/**
 * Right-click menu for the sidebar's conversation list as a whole.
 *
 * The standalone way to create a group: right-click anywhere in the list,
 * including the empty space below the last section, and make an empty one.
 * The other entry point, a conversation's own "New group…", requires
 * something to file first.
 *
 * Two details make it safe to layer over a list whose rows and section headers
 * already have their own context menus:
 *
 * - `ContextMenu.Trigger` stops `contextmenu` from propagating, so the
 *   innermost trigger wins and a right-click on a row opens the row's menu
 *   only. This wrapper is what that behavior exists for.
 * - The wrapper stretches (`flex-1`) to fill the scrollport, so the empty area
 *   under the sections is part of the target rather than dead space.
 *
 * Desktop-only for now: on touch, Radix arms this on long-press, the same
 * gesture the conversation rows and section headers already use for their
 * bottom sheets. Giving the list a competing long-press target needs its own
 * gesture pass.
 */

import { FolderPlus } from "lucide-react";
import type { ReactNode } from "react";

import { ContextMenu } from "@vellumai/design-library";

import { isPointerCoarse } from "@/utils/pointer";

export interface SidebarListContextMenuProps {
  /** Open the "New group" dialog. Omit to render children unwrapped. */
  onCreateGroup?: () => void;
  children: ReactNode;
}

export function SidebarListContextMenu({
  onCreateGroup,
  children,
}: SidebarListContextMenuProps) {
  if (!onCreateGroup || isPointerCoarse()) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {/* `gap-4` restates the Body's own gap: wrapping the sections in one
            element makes them a single flex item, so the spacing they relied
            on has to be reproduced here. */}
        <div
          data-slot="sidebar-list-context-target"
          className="flex flex-1 flex-col gap-4"
        >
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item
          leftIcon={<FolderPlus size={14} />}
          onSelect={onCreateGroup}
        >
          New group…
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
