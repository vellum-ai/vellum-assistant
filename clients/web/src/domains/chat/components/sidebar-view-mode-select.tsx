/**
 * The sidebar's grouping dropdown, under the "Group by" label in the
 * "Conversations" header's actions popover.
 */

import { Select } from "@vellumai/design-library/components/select";

import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";

const VIEW_MODE_OPTIONS: { value: SidebarViewMode; label: string }[] = [
  { value: "all", label: "None" },
  { value: "grouped", label: "Channel" },
];

export interface SidebarViewModeSelectProps {
  value: SidebarViewMode;
  onChange: (next: SidebarViewMode) => void;
}

export function SidebarViewModeSelect({
  value,
  onChange,
}: SidebarViewModeSelectProps) {
  return (
    <Select<SidebarViewMode>
      options={VIEW_MODE_OPTIONS}
      value={value}
      onChange={onChange}
      aria-label="Group conversations by"
      size="compact"
    />
  );
}
