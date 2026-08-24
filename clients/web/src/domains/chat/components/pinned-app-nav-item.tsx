import { PinOff, Rocket } from "lucide-react";

import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { PinnedAppColorSwatches } from "@/domains/chat/components/pinned-app-color-swatches";
import { pinTintStyle } from "@/domains/chat/utils/pin-color-registry";
import { useTranslation } from "@/i18n";
import type { PinnedAppView } from "@/hooks/pinned-apps";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
import { ContextMenu, PanelItem, SideMenu } from "@vellumai/design-library";

export interface PinnedAppNavItemProps {
  app: PinnedAppView;
  active: boolean;
  collapsed: boolean;
  onOpen?: (appId: string) => void;
  /**
   * Pin actions, owned by the block that lists the pins. It holds the assistant
   * id the pin is written against, so a row never has to know one.
   */
  onUnpin: (appId: string) => void;
  onSetColor: (appId: string, color: string | null) => void;
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
 * The unpin lives here as well as on the Library card so a pin can be cleared
 * from the place it is showing, without first finding the app it points at.
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
 * A third path on the expanded row: an unpin button on its trailing edge,
 * revealed with the row where the device can hover and standing there where it
 * cannot. The row has one command, so hiding it would leave a screen reader and
 * a switch control nothing to announce: a swipe's buttons are outside the
 * accessibility tree until the swipe reveals them, and neither a swipe nor a
 * long press is a control anything can name.
 */
export function PinnedAppNavItem({
  app,
  active,
  collapsed,
  onOpen,
  onUnpin,
  onSetColor,
}: PinnedAppNavItemProps) {
  const { t } = useTranslation("chat");

  /* The pin's colour, as the three custom properties both shapes read, and
     `undefined` on an uncoloured pin so neither shape sees a declaration and
     both wear their plain surface.

     Declared on the row element itself rather than on a wrapper, which the
     rail tile rules out: the tile centres itself with `mx-auto` against the
     rail column, and a wrapper would become the thing it centres in. A custom
     property resolves on the element that declares it, so one mechanism
     covers both shapes. */
  const tintStyle = pinTintStyle(app.pinColor);

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
      onSelect={onOpen ? () => onOpen(app.id) : undefined}
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
        value={app.pinColor}
        onChange={(color) => onSetColor(app.id, color)}
      />
      <ContextMenu.Separator />
      <ContextMenu.Item
        leftIcon={<PinOff size={14} />}
        onSelect={() => onUnpin(app.id)}
      >
        {t("pinnedAppNavItem.unpin")}
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
      onSelect={onOpen ? () => onOpen(app.id) : undefined}
      trailingAction={
        <button
          type="button"
          aria-label={t("pinnedAppNavItem.unpinAria", { name: app.name })}
          onClick={(event) => {
            event.stopPropagation();
            onUnpin(app.id);
          }}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)]"
        >
          <PinOff size={12} aria-hidden />
        </button>
      }
    />
  );

  /* Ungated: `SwipeActionReveal` arms the gesture only where a swipe is the
     input, and passes through untouched everywhere else. */
  const trailingActions: SwipeAction[] = [
    {
      id: "unpin",
      label: t("pinnedAppNavItem.unpin"),
      icon: PinOff,
      variant: "destructive",
      onSelect: () => onUnpin(app.id),
    },
  ];

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
