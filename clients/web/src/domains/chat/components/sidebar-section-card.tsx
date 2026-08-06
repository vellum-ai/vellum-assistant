/**
 * One sidebar section, drawn as a card.
 *
 * The card is the unit of the sidebar: Pinned, each custom group, each
 * channel, and the chat list are all this same shell with different contents.
 *
 * This component owns *only* the card surface. The header, chevron, collapse
 * behavior, collapsed-only indicator, right-click and long-press menus, and
 * drag-to-reorder all come from {@link CollapsibleNavSection.Section}, which
 * every sidebar section already uses. Anything that belongs to "a sidebar
 * section" belongs there, not here, so the card and the sections it replaces
 * can never drift in typography, geometry, or pointer behavior.
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

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";

export type SidebarSectionCardProps = ComponentProps<
  typeof CollapsibleNavSection.Section
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
      <CollapsibleNavSection.Section {...section} />
    </Card.Root>
  );
}
