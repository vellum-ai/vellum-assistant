import { PinOff, Rocket } from "lucide-react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnedAppEntry } from "@/utils/app-pin-storage";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
import { ContextMenu, PanelItem, SideMenu } from "@vellumai/design-library";

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
      /* The collapsed-rail affordance, surface included. */
      shape="tile"
      showCollapsedTooltip
      active={active}
      onSelect={onOpen ? () => onOpen(app.appId) : undefined}
      className="text-[color:var(--content-default)]"
    />
  );

  if (collapsed) {
    return sideMenuItem;
  }

  /* A pill, so a pinned app reads as its own object rather than as a row in
     a list. The unpin rides in `trailingAction`, which is why this is a
     `PanelItem` and the collapsed branch above is not: `SideMenu.Item` has no
     trailing slot, so the same button previously had to be a sibling
     absolutely positioned over the row's right edge. */
  const item = (
    <PanelItem
      shape="pill"
      /* An app's icon is an emoji string on its manifest, so it goes in
         `leadingSlot`; `icon` takes a Lucide component, which is the fallback
         for an app with no emoji. Exactly one of the two is ever set. The
         emoji box matches the one `SideMenu.Item` renders for the same value. */
      icon={typeof app.icon === "string" ? undefined : (app.icon ?? Rocket)}
      leadingSlot={
        typeof app.icon === "string" ? (
          <span
            aria-hidden
            className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[14px] leading-none"
          >
            {app.icon}
          </span>
        ) : undefined
      }
      label={app.name}
      active={active}
      onSelect={onOpen ? () => onOpen(app.appId) : undefined}
      trailingAction={
        <button
          type="button"
          aria-label={`Unpin ${app.name}`}
          onClick={(event) => {
            event.stopPropagation();
            unpin(app.appId);
          }}
          /* Desktop-only affordance: touch has no hover to reveal it first,
             so without this a tap in this corner would unpin the app instead
             of opening it. Touch has the swipe and long-press paths below.
             `focus-visible:pointer-events-auto` keeps it reachable for
             keyboard and switch-control on a touch device. */
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] group-hover/panel-item:opacity-100 focus-visible:opacity-100 pointer-coarse:pointer-events-none pointer-coarse:focus-visible:pointer-events-auto"
        >
          <PinOff size={12} aria-hidden />
        </button>
      }
    />
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
