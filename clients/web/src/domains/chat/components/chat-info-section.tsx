/**
 * One row of the Chat Info panel: a header carrying the category title, its
 * exact total, and a See All control, over a single line of tiles.
 *
 * The row is tile-agnostic. Callers pass `renderTile` and the tile's width, so
 * apps (184px) and files or camera frames (135px) share this component and one
 * fit rule.
 */

import { useId } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Button, ScrollShadow, Typography } from "@vellumai/design-library";

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import { MidlineDot } from "@/components/midline-dot";
import { useElementSize } from "@/hooks/use-element-size";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";

/** Gutter between tiles, read by both the fit rule and the rows that draw it. */
const CHAT_INFO_TILE_GAP_PX = 8;

/** Feeds the strip's own margin and padding classes below. */
const STRIP_BLEED_STYLE = {
  "--chat-info-strip-bleed": `${DETAIL_SHELL_BODY_INSET_PX}px`,
} as CSSProperties;

const TILE_ROW_STYLE: CSSProperties = { gap: CHAT_INFO_TILE_GAP_PX };

/** Whole tiles that fit on one line of `rowWidth`, never fewer than one. */
export function fitTileCount(rowWidth: number, tileWidth: number): number {
  if (!(rowWidth > 0)) {
    return 1;
  }
  const gap = CHAT_INFO_TILE_GAP_PX;
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
  renderTile: (item: T, layout: "fitted" | "strip") => ReactNode;
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
  const titleId = useId();
  const { ref, size } = useElementSize();
  const isMobile = useIsMobile();
  // The strip's bleed is padding, not extra room, so one fit serves both layouts.
  const fit = fitTileCount(size.w, tileWidth);
  const showSeeAll = count > fit;

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      style={STRIP_BLEED_STYLE}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1">
          <Typography
            id={titleId}
            variant="title-small"
            className="truncate text-[var(--content-emphasised)]"
          >
            {title}
          </Typography>
          <MidlineDot className="bg-[var(--content-disabled)]" />
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
          `DetailShell`'s body inset so tiles run to the viewport edge. */}
      <div ref={ref} className="w-full">
        {isMobile ? (
          // The reclaimed inset is paid back as padding on both edges, so a
          // line that fits inside the column is exactly as wide as its
          // scroller and does not scroll, while a longer one stops with the
          // inset showing past its last tile.
          <ScrollShadow
            orientation="horizontal"
            hideScrollBar
            className="-mx-[var(--chat-info-strip-bleed)] px-[var(--chat-info-strip-bleed)]"
          >
            <div className="flex w-max" style={TILE_ROW_STYLE}>
              {items.map((item) => renderTile(item, "strip"))}
            </div>
          </ScrollShadow>
        ) : (
          <div className="flex w-full" style={TILE_ROW_STYLE}>
            {items.slice(0, fit).map((item) => renderTile(item, "fitted"))}
          </div>
        )}
      </div>
    </section>
  );
}
