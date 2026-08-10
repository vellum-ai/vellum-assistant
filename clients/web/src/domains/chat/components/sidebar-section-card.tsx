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

import type { ComponentProps } from "react";

import { Card } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

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
  /* The card is what drags, not the header inside it. A section is a card
     now, so grabbing one should pick up the whole object; with the handle on
     the header the drag image was a lone header strip, which reads as a
     conversation row rather than as the section being moved. The drop
     feedback moves with it for the same reason: the insertion line belongs
     on the edge being inserted against. */
  return (
    <Card.Root
      bordered={false}
      noPadding
      className={cn(
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
        "w-fit rounded-[18px]",
        "has-[[data-state=open]]:w-full",
        /* `width` toggles between the sizing keywords `fit-content` (via
           `w-fit`) and a percentage (via `w-full`), not two plain lengths -
           not something a transition can interpolate smoothly regardless of
           easing. It snaps immediately in both directions (`step-start`)
           rather than waiting for the row list's height to finish: that
           delay only mattered while `border-radius` was also changing shape
           and needed the box to still be wide, but radius is now a fixed
           18px in every state (see above), so there's nothing left for the
           width snap to wait on. */
        "transition-[width] duration-[var(--anim-slow)] ease-[step-start]",
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
