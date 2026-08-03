/**
 * The sidebar's List / Grouped view switch, under the "View As" label in the
 * "Conversations" header's actions popover.
 */

import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";

const VIEW_MODE_ITEMS: { value: SidebarViewMode; label: string }[] = [
  { value: "all", label: "List" },
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
    <SegmentControl<SidebarViewMode>
      items={VIEW_MODE_ITEMS}
      value={value}
      onChange={onChange}
      ariaLabel="Conversation list view"
      size="sm"
    />
  );
}
