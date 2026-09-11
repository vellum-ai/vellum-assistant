/**
 * The control at the foot of an expandable section (Chats, a channel
 * section, when it is the rail's bottom-most): "Expand" grows the section
 * from its mid height to the full height the rail has left, "Collapse"
 * brings it back. The rows scroll the same way inside either height; only
 * how much of the list is in view changes.
 *
 * It sits below the section's own scroller, at the card's foot, rather than
 * as the last entry of the rows: the rail is height-constrained by design,
 * and a control at the end of the rows would sit under the fold of the very
 * scroller the control exists to size. Pinned, it is one click away from
 * anywhere in the list.
 *
 * A `Button` in the section-title ink, not a `PanelItem` row: a row would
 * sit in the list as one more thread, and a thread is what the reader is
 * scanning for. The paired chevrons and the quieter ink are what say "this
 * is the card's own control". `shrink-0` holds its height when the rail
 * squeezes the scroller beside it.
 */

import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface SidebarExpandRowProps {
  expanded: boolean;
  onToggle: () => void;
}

export function SidebarExpandRow({ expanded, onToggle }: SidebarExpandRowProps) {
  const { t } = useTranslation("chat");

  return (
    <div
      data-slot="sidebar-expand-row"
      className="mt-1 flex h-[30px] shrink-0 items-center px-[2px]"
    >
      <Button
        variant="ghost"
        size="compact"
        leftIcon={expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        onClick={onToggle}
        aria-expanded={expanded}
        className="text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
      >
        {expanded
          ? t("sidebarExpandRow.collapse")
          : t("sidebarExpandRow.expand")}
      </Button>
    </div>
  );
}
