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
 * scanning for. The chevron and the quieter ink are what say "this is the
 * card's own control". `shrink-0` holds its height when the rail squeezes
 * the scroller beside it.
 *
 * It is set in the rows' own type (`text-body-medium-lighter`, the
 * `PanelItem` size), not the compact button's 12px/500: smaller, bolder and
 * greyer all at once read as a foreign element, and the ink alone is enough
 * to say "control" once the size and weight match its neighbours. The
 * chevron goes in as a child rather than `rightIcon`, which the compact size
 * pins to 10px inline: at that size the glyph is a thin mark shorter than
 * the text's x-height, floating off the word behind the 6px icon gap. A
 * 16px glyph with a 4px gap sits with the word, after it, so the label
 * starts where every thread title starts. A single chevron, down to expand
 * and up to collapse, rather than a paired pair: it points where the card
 * is about to grow.
 *
 * Left-aligned with the rows: the button's 5px lead-in plus its 1px border
 * puts its label on the same x as a `PanelItem`'s text (the row list's
 * inset plus the row's own 6px), and its hover pill starts where a row's
 * does. The row is the same 30px as a thread row and sits inside the
 * list's own 8px bottom inset, so the card keeps a little more air under
 * its footer than over its header: a control right on the edge would read
 * as cramped.
 */

import { ChevronDown, ChevronUp } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface SidebarExpandRowProps {
  expanded: boolean;
  onToggle: () => void;
}

export function SidebarExpandRow({
  expanded,
  onToggle,
}: SidebarExpandRowProps) {
  const { t } = useTranslation("chat");

  return (
    <div
      data-slot="sidebar-expand-row"
      className="mt-1 flex h-[30px] shrink-0 items-center"
    >
      <Button
        variant="ghost"
        size="compact"
        onClick={onToggle}
        aria-expanded={expanded}
        className="gap-1 px-[5px] text-body-medium-lighter text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
      >
        {expanded
          ? t("sidebarExpandRow.collapse")
          : t("sidebarExpandRow.expand")}
        {expanded ? (
          <ChevronUp className="size-4" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
