/**
 * The sidebar's All / Grouped view switch.
 *
 * Sits directly above the list it governs, below Pinned and the custom
 * groups, which it does not affect: those stay put in either view, so putting
 * the switch under them is what makes its scope legible.
 */

import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import { SIDEBAR_ROW_PADDING_X } from "@/components/sidebar-nav-geometry";
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
    /* Inset to the shared row padding so the control's edges line up with the
       conversation titles beside it. Size and width are the primitive's own:
       `sm` for a rail-dense row height, and its default full width, which
       splits evenly between the segments - so the halves stay equal whatever
       the labels say, and "Grouped" gets no bigger a target than "All". */
    <div style={{ paddingInline: SIDEBAR_ROW_PADDING_X }}>
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
