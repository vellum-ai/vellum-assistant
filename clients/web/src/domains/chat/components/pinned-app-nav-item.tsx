import { PinOff, Rocket } from "lucide-react";

import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnedAppEntry } from "@/utils/app-pin-storage";
import { ContextMenu, SideMenu } from "@vellumai/design-library";

export interface PinnedAppNavItemProps {
  app: PinnedAppEntry;
  active: boolean;
  collapsed: boolean;
  onOpen?: (appId: string) => void;
}

/**
 * A pinned-app row in the assistant sidebar. Renders the app as a
 * {@link SideMenu.Item} and, when expanded, wraps it in a right-click /
 * long-press {@link ContextMenu} whose sole action removes the pin.
 *
 * The unpin lives here because it is the only place a stale pin can be
 * cleared: a deleted app never appears in the Library, so its card-level
 * unpin is unreachable, leaving the sidebar entry orphaned.
 *
 * In the collapsed rail the item is wrapped in a Tooltip whose provider
 * would swallow the context-menu trigger's cloned handlers, so the menu is
 * omitted there — the overlay and expanded rail (always available on mobile
 * and the default desktop width) carry the affordance.
 */
export function PinnedAppNavItem({
  app,
  active,
  collapsed,
  onOpen,
}: PinnedAppNavItemProps) {
  const unpin = usePinnedAppsStore.use.unpin();

  const item = (
    <SideMenu.Item
      // Apps source their icon as an emoji string on the manifest
      // (`app.icon`). Fall back to the Rocket lucide glyph so unmojified
      // apps still get a leading icon in the rail.
      icon={app.icon ?? Rocket}
      label={app.name}
      showCollapsedTooltip
      active={active}
      onSelect={onOpen ? () => onOpen(app.appId) : undefined}
    />
  );

  if (collapsed) {
    return item;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{item}</ContextMenu.Trigger>
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        <ContextMenu.Item
          leftIcon={<PinOff size={14} />}
          onSelect={() => unpin(app.appId)}
        >
          Unpin
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
