import { PinOff, Rocket } from "lucide-react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { PinnedAppColorSwatches } from "@/domains/chat/components/pinned-app-color-swatches";
import { pinTintStyle } from "@/domains/chat/utils/pin-color-registry";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnedAppEntry } from "@/utils/app-pin-storage";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
import {
  ContextMenu,
  PanelItem,
  SideMenu,
} from "@vellumai/design-library";

export interface PinnedAppNavItemProps {
  app: PinnedAppEntry;
  active: boolean;
  collapsed: boolean;
  onOpen?: (appId: string) => void;
}

/**
 * A pinned-app row in the assistant sidebar. Renders the app as a
 * {@link SideMenu.Item} and, when expanded, wraps it in a right-click /
 * long-press {@link ContextMenu} offering a colour for the pin and an unpin.
 *
 * A pin the user has given a colour wears it as a wash rather than the solid
 * fill the assistant identity pill above it wears, so that pill stays the
 * sidebar's one saturated surface. The colour rides onto the collapsed rail
 * with the row, because collapsing changes the shape of a thing and not what
 * colour it is.
 *
 * The unpin lives here because it is the only place a stale pin can be
 * cleared: a deleted app never appears in the Library, so its card-level
 * unpin is unreachable, leaving the sidebar entry orphaned.
 *
 * Both shapes carry the menu, because the rail changes what a pinned app
 * looks like and not what can be done to it. The collapsed tile depends on it
 * most: it has no hover button and nothing to swipe, so the menu is its only
 * route to an unpin, reached by right click or by long press.
 *
 * On touch, the expanded row additionally reveals an Unpin button on a left
 * swipe. The tile omits that: it has nowhere to swipe to, and the actions a
 * swipe reveals are sized for a full-width row.
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
  const setColor = usePinnedAppsStore.use.setColor();

  /* The pin's colour, as the three custom properties both shapes read, and
     `undefined` on an uncoloured pin so neither shape sees a declaration and
     both wear their plain surface.

     Declared on the row element itself rather than on a wrapper, which the
     rail tile rules out: the tile centres itself with `mx-auto` against the
     rail column, and a wrapper would become the thing it centres in. A custom
     property resolves on the element that declares it, so one mechanism
     covers both shapes. */
  const tintStyle = pinTintStyle(app.color);

  const sideMenuItem = (
    <SideMenu.Item
      style={tintStyle}
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

  /* One definition for both shapes. The rail changes what a pinned app looks
     like, not what can be done to it, and the collapsed tile is the shape with
     the most riding on this: it has no hover button and nothing to swipe, so
     the menu is its only route to an unpin. */
  const menu = (
    <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
      <PinnedAppColorSwatches
        value={app.color}
        onChange={(color) => setColor(app.appId, color)}
      />
      <ContextMenu.Separator />
      <ContextMenu.Item
        leftIcon={<PinOff size={14} />}
        onSelect={() => unpin(app.appId)}
      >
        Unpin
      </ContextMenu.Item>
    </ContextMenu.Content>
  );

  if (collapsed) {
    /* No `SwipeActionReveal`: a 30px tile has nowhere to swipe to, and the
       actions it reveals are sized for a full-width row. Touch reaches the
       same menu by long press, which is what the trigger already does. */
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>{sideMenuItem}</ContextMenu.Trigger>
        {menu}
      </ContextMenu.Root>
    );
  }

  /* A pill, so a pinned app reads as its own object rather than as a row in
     a list. The unpin rides in `trailingAction`, which is why this is a
     `PanelItem` and the collapsed branch above is not: `SideMenu.Item` has no
     trailing slot, so the same button previously had to be a sibling
     absolutely positioned over the row's right edge. */
  const item = (
    <PanelItem
      style={tintStyle}
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
      {menu}
    </ContextMenu.Root>
  );
}
