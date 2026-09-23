import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";

export type IntegrationListLayout = "row" | "tile";

/**
 * Grows an icon-only action to a full touch target where the pointer is
 * coarse. Both layouts put the action in the same corner at the same size, so
 * the eye tracks one column down the page whether a row offers a gear or a
 * tile offers a plus.
 */
export const INTEGRATION_ACTION_SIZING = "pointer-coarse:size-11";

interface IntegrationListRowProps {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  primaryAction: ReactNode;
  actionMenu?: ReactNode;
  layout?: IntegrationListLayout;
}

/**
 * Classes shared by the action slot in both layouts. The action is drawn at
 * rest rather than revealed on hover: it is the one thing a card exists for,
 * a hover has no equivalent on touch, and an affordance nobody can see does
 * not get used.
 */
const ACTION_SLOT = [
  // The slot wraps rather than shrinks: its children are fixed-size targets,
  // and a phone-width card with a verb on its action has to put the overflow
  // menu on a second line instead of off the card.
  "flex flex-wrap items-start gap-2 [&>*]:shrink-0",
  "[&_button]:max-w-full [&_button]:whitespace-normal",
  "[&_button]:pointer-coarse:min-h-11",
].join(" ");

export function IntegrationListRow({
  icon,
  title,
  subtitle,
  status,
  primaryAction,
  actionMenu,
  layout = "row",
}: IntegrationListRowProps) {
  if (layout === "tile") {
    return (
      <Card.Root
        bordered
        className="flex h-full flex-col gap-3 transition-colors hover:border-[var(--border-hover)]"
      >
        <div className="flex items-start justify-between gap-2">
          {icon}
          <div className={`${ACTION_SLOT} justify-end`}>
            {primaryAction}
            {actionMenu}
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          {/*
           * The title wraps instead of truncating. `text-title-small` sets a
           * line-height of 1, so the line box is shorter than the glyphs it
           * holds and any `overflow-hidden` on it shaves the descenders off
           * (the tail of a "g"). Wrapping keeps long names readable too.
           */}
          <p className="text-title-small text-[var(--content-default)] [overflow-wrap:anywhere]">
            {title}
          </p>
          {/*
           * Two lines, reserved whether or not there are two lines to put in
           * them. These are grid cells and the row stretches to its tallest,
           * so a tile whose description runs to one line and a tile that has
           * something else to say here both have to occupy the same block or
           * the whole row moves when one of them changes.
           *
           * `min-h-9` is two lines of `text-body-small-lighter`, whose
           * line-height token is 18px.
           */}
          <p className="line-clamp-2 min-h-9 text-body-small-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
            {subtitle}
          </p>
        </div>
      </Card.Root>
    );
  }

  /*
   * The row is the tile turned on its side: logo, then everything the card
   * has to say, then the action in the same top-right corner at the same
   * size, so a page of rows and tiles side by side reads as one list with one
   * action column.
   */
  return (
    <Card.Root>
      {/*
       * The action holds the top-right cell at every card width, level with
       * the icon and the title, so a page of rows and tiles keeps one action
       * column. The two content columns share what is left: the text keeps a
       * floor wide enough to read, and the action column can be squeezed
       * below its natural width, where a button carrying a verb wraps its
       * label rather than leaning on the card's edge.
       */}
      <Card.Body
        padding="md"
        className="grid grid-cols-[2rem_minmax(6rem,1fr)_minmax(0,auto)] items-start gap-x-3"
      >
        {icon}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-title-small text-[var(--content-default)] [overflow-wrap:anywhere]">
              {title}
            </p>
            {status}
          </div>
          {subtitle ? (
            <p className="line-clamp-2 text-body-medium-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className={`${ACTION_SLOT} col-start-3 row-start-1 justify-end`}>
          {primaryAction}
          {actionMenu}
        </div>
      </Card.Body>
    </Card.Root>
  );
}
