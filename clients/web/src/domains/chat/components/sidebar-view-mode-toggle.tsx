/**
 * The sidebar's All / Grouped view switch.
 *
 * Leads the sidebar and sticks to the top of the scrollport, so the choice is
 * reachable from anywhere in a list that can run tens of thousands of pixels
 * tall.
 */

import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";

const VIEW_MODE_ITEMS: { value: SidebarViewMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "grouped", label: "Groups" },
];

export interface SidebarViewModeToggleProps {
  value: SidebarViewMode;
  onChange: (next: SidebarViewMode) => void;
}

export function SidebarViewModeToggle({
  value,
  onChange,
}: SidebarViewModeToggleProps) {
  return (
    /* Sticky, so the view switch is reachable from anywhere in a list that
       can run tens of thousands of pixels tall. It needs the sidebar's own
       surface behind it and a z-index, or rows would scroll through it, and
       A sticky offset is measured from the scrollport's *content* box, so
       this only lands flush against the header because the body carries no
       top inset for it to sit below. Adding one back there would open a strip
       above this that rows scroll through.

       It spans the full scrollport width and carries no padding of its own,
       so the list runs right up under it. Size and width are the primitive's
       own:
       `sm` for a rail-dense row height, and its default full width, which
       splits evenly between the segments - so the halves stay equal whatever
       the labels say, and "Groups" gets no bigger a target than "All". */
    <div
      className="sticky top-0 z-20 bg-[var(--surface-overlay)]"
    >
      <SegmentControl<SidebarViewMode>
        items={VIEW_MODE_ITEMS}
        value={value}
        onChange={onChange}
        ariaLabel="Conversation list view"
        size="sm"
      />
    </div>
  );
}
