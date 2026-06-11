/**
 * Shared web-search step-row primitives consumed by both
 * `SingleActivity variant="web"` (the lone web-search inline link) and
 * `MultiActivityGroup` (the unified card that handles mixed groups).
 *
 * Lifted here to dedupe the previously copy/pasted `OverflowChip` definitions
 * and the `web_search` / `web_search_error` step renderers across the two
 * callsites. Keeping a single source of truth ensures that ExpandedStep in
 * the unified card and renderStep in the dedicated web-search card present
 * identical visuals for the same step descriptors.
 */

import { AlertCircle } from "lucide-react";
import { useState } from "react";

import { Popover, Typography } from "@vellumai/design-library";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

/**
 * First uppercase letter of the result's domain (falling back to its title),
 * used as the monogram when a favicon is missing or fails to load.
 */
function monogramLetter(item: WebSearchResultItem): string {
  const source = item.domain && item.domain.length > 0 ? item.domain : item.title;
  const first = source.charAt(0);
  return first ? first.toUpperCase() : "";
}

/**
 * A single source row inside the overflow popover. Renders the site favicon
 * (with a monogram fallback that survives image load errors), the page title,
 * and the domain, all wrapped in an external link that opens the source in a
 * new tab. Mirrors the chat's existing external-link convention (plain
 * `target="_blank"` anchors, as used by `ChatMarkdownMessage` and the
 * surface views) rather than introducing bespoke navigation.
 */
function OverflowSourceLink({ item }: { item: WebSearchResultItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasFavicon = Boolean(item.faviconUrl) && !imageFailed;

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--surface-hover)]"
    >
      <span
        aria-hidden="true"
        className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-overlay)]"
      >
        {hasFavicon ? (
          <img
            src={item.faviconUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => setImageFailed(true)}
          />
        ) : (
          // typography: off-scale — 10px monogram inside 14px favicon slot
          <span className="text-[10px] font-medium leading-none text-[var(--content-default)]">
            {monogramLetter(item)}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <Typography
          variant="body-small-default"
          className="truncate text-[var(--content-default)]"
        >
          {item.title}
        </Typography>
        <Typography
          variant="body-small-default"
          className="truncate text-[var(--content-secondary)]"
        >
          {item.domain}
        </Typography>
      </span>
    </a>
  );
}

/**
 * Interactive "+N more" pill rendered at the tail of a `web_search` row when
 * the result list was clamped. Clicking it opens a popover listing the
 * remaining (hidden) sources as links so they stay reachable — without it the
 * pill would be a dead-end with no way to inspect the additional results.
 *
 * The trigger visually matches `FaviconChip` so the pill sits flush in the
 * same row: identical outer geometry (`inline-flex items-center`, 10/6
 * padding, pill radius, `--surface-base` fill), identical Inter Medium 12
 * typography (`body-small-default`), and a `min-h-[26px]` floor so the chip
 * matches the favicon chips' natural height.
 */
export function OverflowChip({ results }: { results: WebSearchResultItem[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="web-search-overflow-chip"
          className="inline-flex min-h-[26px] cursor-pointer items-center rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-[10px] py-[6px] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          <Typography
            variant="body-small-default"
            className="text-[var(--content-default)]"
          >
            +{results.length} more
          </Typography>
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="start"
        side="bottom"
        className="flex max-h-[260px] w-[280px] flex-col gap-0.5 overflow-y-auto"
      >
        {results.map((r) => (
          <OverflowSourceLink key={r.rank} item={r} />
        ))}
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * Negatively-toned chip used inside a `web_search_error` step row to
 * surface the provider's `errorMessage`. Mirrors the default pill's
 * outlined geometry but swaps the border + foreground tokens for the
 * `--system-negative-*` family so the failure reads as distinct from a
 * normal reasoning step.
 */
function ErrorChip({ message }: { message: string }) {
  return (
    <div
      data-testid="web-search-error-chip"
      className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] px-[10px] py-[6px]"
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <AlertCircle className="h-[14px] w-[14px] text-[var(--system-negative-strong)]" />
      </span>
      <Typography
        variant="body-small-default"
        className="text-[var(--system-negative-strong)]"
      >
        {message}
      </Typography>
    </div>
  );
}

/**
 * Render a single `web_search` step as a wrapping cluster of favicon chips,
 * optionally followed by a `+N more` overflow pill when the unified hook
 * clamped the visible result count. The pill reveals the clamped sources in a
 * popover.
 *
 * Keyed by `rank` (the documented uniqueness invariant on
 * `WebSearchResultItem`) rather than `url` — providers occasionally return
 * duplicate URLs, which would collide as React keys and cause stale/missing
 * chips during live updates.
 */
export function WebSearchStepRow({
  step,
}: {
  step: Extract<ToolCallCardStep, { kind: "web_search" }>;
}) {
  const overflowResults = step.overflowResults ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {(step.results ?? []).map((r) => (
        // Each result is a `ToolStepPill` web variant — the same pill chrome as
        // tool steps, with the site favicon as the glyph, that opens the source
        // in a new tab.
        <ToolStepPill
          key={r.rank}
          variant="web"
          url={r.url}
          faviconUrl={r.faviconUrl}
          domain={r.domain}
          label={r.title}
        />
      ))}
      {overflowResults.length > 0 ? (
        <OverflowChip results={overflowResults} />
      ) : null}
    </div>
  );
}

/**
 * Render a single `web_search_error` step as an `ErrorChip` containing the
 * provider-supplied error message.
 */
export function WebSearchErrorRow({
  step,
}: {
  step: Extract<ToolCallCardStep, { kind: "web_search_error" }>;
}) {
  return <ErrorChip message={step.errorMessage} />;
}
