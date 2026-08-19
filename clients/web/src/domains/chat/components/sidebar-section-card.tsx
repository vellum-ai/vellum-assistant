/**
 * One sidebar section, drawn as a card.
 *
 * The card is the unit of the sidebar: Pinned, each custom group, each
 * channel, and the chat list are all this same shell with different contents.
 *
 * This component owns *only* the card surface. The header, chevron, collapse
 * behavior, collapsed-only indicator, row list, and drag-to-reorder all come
 * from {@link ConversationNavSection}. Anything that belongs to "a sidebar
 * section" belongs there, not here, so every section reads identically in
 * typography, geometry, and pointer behavior whether or not it sits on a
 * card.
 *
 * That layer is also what keeps the two menus distinct. A section's own
 * actions (mark all read, archive all, rename, delete, reorder) come from a
 * single `groupMenu`, which it renders into both the header's right-click
 * menu and, on touch, its long-press sheet. A conversation's actions (pin,
 * archive, move to group, inspect) stay on {@link ConversationRow}. The two
 * never share a surface: right-clicking a header offers section actions,
 * right-clicking a row offers that row's.
 *
 * Sections stay members of one {@link CollapsibleNavSection.Root} so their
 * open state is managed in a single place; the card surface sits between the
 * root and the item.
 *
 * Purely presentational. It owns no query and no membership rule: rows and
 * indicator are handed in, which is what lets every section load from its own
 * server-filtered query (LUM-2443) without this component knowing the others
 * exist. Its menu is scoped to this section alone, so a section's bulk actions
 * and its contents always describe the same rows (LUM-3008).
 */

import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { Card } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationNavSection } from "@/domains/chat/components/conversation-nav-section";

export type SidebarSectionCardProps = ComponentProps<
  typeof ConversationNavSection
> & {
  /** Extra classes for the card surface, not the section inside it. */
  cardClassName?: string;
};

export function SidebarSectionCard({
  cardClassName,
  drag,
  ...section
}: SidebarSectionCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { overlayCards } = useConversationListContext();

  /* `width` toggling between the sizing keywords `fit-content` and a
     percentage doesn't animate smoothly on its own - measured directly,
     Chromium holds the *old* value for the whole transition and only
     snaps at the very end, `interpolate-size: allow-keywords` included, so
     a plain CSS toggle can't do this. A real pixel value can: it's an
     ordinary length, so transitioning between it and a percentage is the
     same kind of interpolation `border-radius` or any other numeric
     property already does reliably.

     So this measures the pill's own collapsed width and republishes it as
     a CSS var - but not by waiting to observe the card at its collapsed
     size, because a section that starts open (Chats, Pinned) or has never
     been collapsed yet would have no value to fall back on for its very
     first collapse, hitting the exact keyword-transition problem this
     exists to avoid. Instead it forces the measurement regardless of
     current open state: temporarily hides the row list (the one thing
     that can make the card wider than its own header) and collapses the
     card to `fit-content` to read its true hug width, then restores both -
     synchronously, in the same layout-effect pass, so nothing paints in
     between and there's no visible flash. Re-measures whenever the header
     content that determines that width could have changed. */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const content = card.querySelector<HTMLElement>(".sidebar-section-list");
    const prevContentDisplay = content?.style.display;
    const prevCardWidth = card.style.width;
    if (content) {
      content.style.display = "none";
    }
    card.style.width = "fit-content";
    const width = card.getBoundingClientRect().width;
    card.style.width = prevCardWidth;
    if (content) {
      content.style.display = prevContentDisplay ?? "";
    }
    card.style.setProperty("--section-collapsed-width", `${width}px`);
  }, [section.icon, section.label]);

  /* The card is what drags, not the header inside it. A section is a card
     now, so grabbing one should pick up the whole object; with the handle on
     the header the drag image was a lone header strip, which reads as a
     conversation row rather than as the section being moved. The drop
     feedback moves with it for the same reason: the insertion line belongs
     on the edge being inserted against. */
  return (
    <Card.Root
      ref={cardRef}
      bordered={false}
      noPadding
      className={cn(
        /* A swipeable row inside this card paints an opaque layer of its own
           so its actions stay hidden until swiped, so the card names the
           surface that layer has to match. Declared here rather than on the
           row: the card is what owns the fill, and every swipeable thing it
           holds inherits the one value. */
        "[--swipe-reveal-bg:var(--surface-lift)]",
        /* No padding of its own: the header row is already a self-contained
           pill (its own height, its own 12px/6px inset) per Figma, and
           wrapping it in another layer of padding would inflate the pill
           past its spec. The row list picks up the matching horizontal
           inset directly (see `CollapsibleNavSection.Section`'s Content). */
        /* Collapsed, a section is a pill that hugs its own header: nothing
           inside it needs the full rail width. Its own `Collapsible.Item`
           descendant carries Radix's `data-state`, so `has-[]` reads that
           state directly rather than this component tracking open/closed
           itself. Open, it becomes a full-width rounded rect to hold its
           row list.

           Radius is the same 18px number in both states - half the pill's
           own 36px height, which is what makes a 36px-tall box read as
           fully round in the first place - rather than switching between
           `rounded-full` and a smaller radius. Same value means nothing
           needs to transition or interpolate for it at all: it can never
           lag behind the width/height change since it never moves. */
        "w-[var(--section-collapsed-width,fit-content)]",
        /* The overlay's card is squarer than the rail's pill and carries the
           inset its header and row list sit flush inside (Figma 7842-83305);
           the rail keeps the radius that makes its 36px header read as fully
           round. */
        overlayCards
          ? "rounded-[16px] pt-2.5 pr-3 pb-1.5 pl-2"
          : "rounded-[18px]",
        "has-[[data-state=open]]:w-full",
        /* `width` toggles between the measured `--section-collapsed-width`
           (a real length - see the `ResizeObserver` above) and a percentage,
           not a length and a sizing keyword, so an ordinary transition
           interpolates it exactly like it would `border-radius`.

           The two directions want different timing, because the row list's
           content and height (`.sidebar-section-list` in tokens.css) both
           collapse instantly, with no animation of their own, and each
           direction lines its own width behavior up with that:

           - Collapsing: content and height are already at their closed
             values in that same instant, so width is the one thing left to
             visibly animate - a quick 100ms is enough to read as a
             deliberate motion without holding up the rest, which has
             already finished.
           - Expanding: content becomes visible in that first instant too,
             so width has to already be at its full value right then
             (`step-start`, an immediate snap) - if it eased in instead, the
             now-visible content would sit at full width inside a box still
             catching up to it. */
        "transition-[width] duration-[100ms]",
        "has-[[data-state=open]]:ease-[step-start]",
        "ease-[var(--anim-ease-out)]",
        /* Only the bottom-most section ever claims leftover flex space (see
           `isLast` on `ConversationRowList`): flex-grow has no notion of
           "this section needs the room," so giving every open section a
           share stretched a two-row group into a mostly-empty box the same
           size as a busy one beside it. */
        !section.unbounded &&
          section.isLast &&
          "has-[[data-state=open]]:flex has-[[data-state=open]]:min-h-0 has-[[data-state=open]]:flex-1 has-[[data-state=open]]:flex-col",
        /* The card is the drag handle, so it says so. Every interactive thing
           inside it sets its own `cursor-pointer`, which wins wherever one is
           actually under the pointer - so the grab cursor shows on the card's
           own surface and nowhere else. */
        drag && "cursor-grab active:cursor-grabbing",
        drag?.dragging && "opacity-50",
        drag?.dropEdge === "before" &&
          "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        drag?.dropEdge === "after" &&
          "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
        cardClassName,
      )}
      {...drag?.headerProps}
    >
      <ConversationNavSection {...section} />
    </Card.Root>
  );
}
