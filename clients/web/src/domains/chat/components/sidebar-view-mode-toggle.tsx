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
    <div
      /* Compact only in height: `SegmentControl` exposes no size prop, so the
         inner `role="radio"` buttons are shrunk with a descendant variant
         rather than by mutating the shared primitive (24px inner + the
         2px-padded container = 28px outer, one row height). Width is left to
         the primitive, which spans the rail and splits it evenly between the
         segments - the halves stay equal whatever the labels say, so
         "Grouped" doesn't get a wider target than "All". */
      className="[&_[role=radio]]:h-6"
      style={{ paddingInline: SIDEBAR_ROW_PADDING_X }}
    >
      <SegmentControl<SidebarViewMode>
        items={VIEW_MODE_ITEMS}
        value={value}
        onChange={onChange}
        ariaLabel="Conversation list view"
      />
    </div>
  );
}
