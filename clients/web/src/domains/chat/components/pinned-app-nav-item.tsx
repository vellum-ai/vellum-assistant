import { PinOff, Rocket } from "lucide-react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnedAppEntry } from "@/utils/app-pin-storage";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
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
 * On touch devices, swiping left reveals an Unpin action button —
 * complementing the long-press context menu. In the collapsed rail the
 * swipe is omitted (the tooltip provider would interfere, same as the
 * context menu).
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

  const trailingActions: SwipeAction[] = isPointerCoarse()
    ? [{
        id: "unpin",
        label: "Unpin",
        icon: PinOff,
        variant: "destructive",
        onSelect: () => unpin(app.appId),
      }]
    : [];

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <SwipeActionReveal trailingActions={trailingActions}>
          {item}
        </SwipeActionReveal>
      </ContextMenu.Trigger>
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
