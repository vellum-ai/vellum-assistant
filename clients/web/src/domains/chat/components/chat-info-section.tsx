/**
 * One row of the Chat Info panel: a header carrying the category title, its
 * exact total, and a See All control, over a single line of tiles.
 *
 * The row is tile-agnostic. Callers pass `renderTile` and the tile's width, so
 * apps (184px) and files or camera frames (135px) share this component and one
 * fit rule.
 */

import type { ReactNode } from "react";

import { Button, ScrollShadow, Typography } from "@vellumai/design-library";

import { useElementSize } from "@/hooks/use-element-size";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";

/** Gutter between tiles, the pixel value behind the rows' `gap-2`. */
export const CHAT_INFO_TILE_GAP_PX = 8;

/** Whole tiles that fit on one line of `rowWidth`, never fewer than one. */
export function fitTileCount(
  rowWidth: number,
  tileWidth: number,
  gap = CHAT_INFO_TILE_GAP_PX,
): number {
  if (!(rowWidth > 0)) {
    return 1;
  }
  return Math.max(1, Math.floor((rowWidth + gap) / (tileWidth + gap)));
}

export interface ChatInfoSectionProps<T> {
  title: string;
  /** The category's exact total, which may exceed `items.length` when the source is paged. */
  count: number;
  items: T[];
  /** Fixed (strip) or minimum (fitted row) width of one tile, for the fit computation. */
  tileWidth: number;
  /** Returns the tile element with its own `key`: the caller owns tile identity. */
  renderTile: (item: T, index: number, layout: "fitted" | "strip") => ReactNode;
  seeAllAriaLabel: string;
  onSeeAll: () => void;
}

/**
 * See All reads `count`, not `items.length`, so a paged category whose first
 * page already overflows one line still offers the drill-in.
 */
export function ChatInfoSection<T>({
  title,
  count,
  items,
  tileWidth,
  renderTile,
  seeAllAriaLabel,
  onSeeAll,
}: ChatInfoSectionProps<T>) {
  const { t } = useTranslation("chat");
  const { ref, size } = useElementSize();
  const isMobile = useIsMobile();
  const fit = fitTileCount(size.w, tileWidth);
  const showSeeAll = count > fit;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1">
          <Typography
            variant="title-small"
            className="truncate text-[var(--content-emphasised)]"
          >
            {title}
          </Typography>
          <span
            aria-hidden
            className="size-[3px] shrink-0 rounded-full bg-[var(--content-disabled)]"
          />
          <Typography
            variant="title-small"
            className="shrink-0 text-[var(--content-disabled)]"
          >
            {count}
          </Typography>
        </span>
        {showSeeAll && (
          // The mock draws See All as plain title-small text at the right edge,
          // so the compact ghost chrome gives up its box and keeps only the
          // hover tint.
          <Button
            variant="ghost"
            size="compact"
            aria-label={seeAllAriaLabel}
            onClick={onSeeAll}
            className="h-auto shrink-0 px-0 text-title-small hover:bg-transparent [--vbtn-fg:var(--content-emphasised)]"
          >
            {t("chatInfoPanel.seeAll")}
          </Button>
        )}
      </div>
      {/* Both layouts are the same "one line" decision read at this one
          measured width, so See All and the visible tiles can never disagree:
          a roomy window truncates the line to what fits, a narrow one scrolls
          the whole fetched set past the same edge. The strip cancels
          `DetailShell`'s 20px body inset so tiles run to the viewport edge. */}
      <div ref={ref} className="w-full">
        {isMobile ? (
          <ScrollShadow
            orientation="horizontal"
            hideScrollBar
            className="-mx-5 px-5"
          >
            <div className="flex w-max gap-2">
              {items.map((item, index) => renderTile(item, index, "strip"))}
            </div>
          </ScrollShadow>
        ) : (
          <div className="flex w-full gap-2">
            {items
              .slice(0, fit)
              .map((item, index) => renderTile(item, index, "fitted"))}
          </div>
        )}
      </div>
    </section>
  );
}
