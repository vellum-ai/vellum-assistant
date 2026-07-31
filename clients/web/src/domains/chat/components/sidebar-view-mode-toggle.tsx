/**
 * The sidebar's All / Grouped view switch.
 *
 * Sits directly above the list it governs, below Pinned and the custom
 * groups, which it does not affect: those stay put in either view, so putting
 * the switch under them is what makes its scope legible.
 */

import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";

const VIEW_MODE_ITEMS: { value: SidebarViewMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "grouped", label: "Grouped" },
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
       A sticky offset is measured from the scrollport's *content* box, so a
       plain `top-0` parks this the full height of the body's top inset below
       the edge and rows slide through the strip above it. The negative `top`
       cancels that inset so it sits flush against the header, and the
       matching negative margin keeps it flush at rest too.

       It spans the full scrollport width and carries no padding of its own,
       so the list runs right up under it. Size and width are the primitive's
       own:
       `sm` for a rail-dense row height, and its default full width, which
       splits evenly between the segments - so the halves stay equal whatever
       the labels say, and "Grouped" gets no bigger a target than "All". */
    <div
      className="sticky -top-3 z-20 -mt-3 bg-[var(--surface-overlay)] max-md:-top-4 max-md:-mt-4"
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
