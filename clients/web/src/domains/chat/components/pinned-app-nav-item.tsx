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
 *
 * On desktop, a third path: a hover-revealed unpin button on the row's
 * trailing edge. `SideMenu.Item` has no `trailingAction` slot (unlike
 * `PanelItem`), and it renders as a real `<button>` when `onSelect` is
 * given, so the unpin button can't nest inside it: it's a sibling,
 * absolutely positioned over the row's right edge by their shared
 * `relative` wrapper.
 */
export function PinnedAppNavItem({
  app,
  active,
  collapsed,
  onOpen,
}: PinnedAppNavItemProps) {
  const unpin = usePinnedAppsStore.use.unpin();

  const sideMenuItem = (
    <SideMenu.Item
      // Apps source their icon as an emoji string on the manifest
      // (`app.icon`). Fall back to the Rocket lucide glyph so unmojified
      // apps still get a leading icon in the rail.
      icon={app.icon ?? Rocket}
      label={app.name}
      showCollapsedTooltip
      active={active}
      onSelect={onOpen ? () => onOpen(app.appId) : undefined}
      className="text-[color:var(--content-default)]"
    />
  );

  if (collapsed) {
    return sideMenuItem;
  }

  const item = (
    <div className="group/pinned-app relative">
      <SideMenu.Item
        icon={app.icon ?? Rocket}
        label={app.name}
        active={active}
        onSelect={onOpen ? () => onOpen(app.appId) : undefined}
        className="pr-8 text-[color:var(--content-default)]"
      />
      <button
        type="button"
        aria-label={`Unpin ${app.name}`}
        onClick={(event) => {
          event.stopPropagation();
          unpin(app.appId);
        }}
        className="absolute top-1/2 right-[6px] flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] group-hover/pinned-app:opacity-100 focus-visible:opacity-100"
      >
        <PinOff size={12} aria-hidden />
      </button>
    </div>
  );

  const trailingActions: SwipeAction[] = isPointerCoarse()
    ? [
        {
          id: "unpin",
          label: "Unpin",
          icon: PinOff,
          variant: "destructive",
          onSelect: () => unpin(app.appId),
        },
      ]
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
