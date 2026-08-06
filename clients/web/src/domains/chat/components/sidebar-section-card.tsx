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
  ...section
}: SidebarSectionCardProps) {
  return (
    <Card.Root bordered={false} noPadding className={cn("p-2", cardClassName)}>
      <ConversationNavSection {...section} />
    </Card.Root>
  );
}
