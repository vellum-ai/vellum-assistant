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
  /**
   * A block under the description, for what the row has to say about itself
   * right now: progress on a connect attempt, or the error it ended in. It
   * sits in the text column in both layouts, so it wraps with the description
   * rather than competing with the action for width.
   */
  footer?: ReactNode;
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
  footer,
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
          {subtitle ? (
            <p className="line-clamp-2 text-body-small-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
          {footer}
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
    <Card.Root className="@container">
      {/*
       * The action takes that corner once the card can spare the width for
       * it. Below 28rem it drops under the text instead: the resting action
       * is a 32px glyph and would fit, but the states that still carry a verb
       * ("Finish connecting") plus an overflow menu would not, and a column
       * that narrow leaves the title a word per line.
       *
       * The text column keeps a floor of its own at the wider size for the
       * same reason.
       */}
      <Card.Body
        padding="md"
        className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 @[28rem]:grid-cols-[2rem_minmax(8rem,1fr)_auto]"
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
          {footer}
        </div>
        <div
          className={`${ACTION_SLOT} col-start-2 @[28rem]:col-start-3 @[28rem]:row-start-1 @[28rem]:justify-end`}
        >
          {primaryAction}
          {actionMenu}
        </div>
      </Card.Body>
    </Card.Root>
  );
}
