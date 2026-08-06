/**
 * Drag-to-reorder for whole sidebar sections.
 *
 * A thin adapter over {@link useDragReorder}: it pins the section key,
 * translates the generic controller into the per-section
 * {@link CollapsibleNavSectionDrag} bundle the nav section renders, and owns
 * the "nothing to reorder against" case.
 *
 * Deliberately a *second* `useDragReorder` instance, separate from the one
 * reordering conversation rows. Each instance keeps its own active-drag ref,
 * so a row drag and a section drag can ride the same HTML5 drag events
 * without either mistaking the other's drag for its own.
 */

import { useCallback } from "react";

import type { CollapsibleNavSectionDrag } from "@/components/collapsible-nav-section";
import { useDragReorder } from "@/domains/chat/hooks/use-drag-reorder";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";

/**
 * `useDragReorder` section key for the section-reordering controller. Drags
 * only land within the key they started in, and sections form a single
 * reorderable list, so one constant covers them all.
 */
const SECTION_DRAG_KEY = "sidebar-sections";

export interface UseSectionDragReorderParams {
  sections: SidebarSection[];
  /** Persist the new order. Receives every section key, in its new order. */
  onReorder: (orderedKeys: string[]) => void;
}

export type SectionDragFor = (
  section: SidebarSection,
) => CollapsibleNavSectionDrag | undefined;

export function useSectionDragReorder({
  sections,
  onReorder,
}: UseSectionDragReorderParams): SectionDragFor {
  const { getItemProps, draggingId, dropIndicator } =
    useDragReorder<SidebarSection>({
      getId: (section) => section.key,
      onReorder: (_key, ordered) =>
        onReorder(ordered.map((section) => section.key)),
    });

  return useCallback(
    (section: SidebarSection) => {
      // A lone section has nothing to reorder against, so it isn't draggable.
      if (sections.length < 2) {
        return undefined;
      }
      return {
        headerProps: getItemProps(SECTION_DRAG_KEY, sections, section),
        dragging: draggingId === section.key,
        dropEdge:
          dropIndicator?.section === SECTION_DRAG_KEY &&
          dropIndicator.itemId === section.key
            ? dropIndicator.edge
            : null,
      };
    },
    [sections, getItemProps, draggingId, dropIndicator],
  );
}
