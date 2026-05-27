/**
 * Shared web-search step-row primitives consumed by both
 * `WebSearchProgressCard` (the dedicated purely-web card) and
 * `ToolCallProgressCard` (the unified card that handles mixed groups).
 *
 * Lifted here to dedupe the previously copy/pasted `OverflowChip` definitions
 * and the `web_search` / `web_search_error` step renderers across the two
 * callsites. Keeping a single source of truth ensures that ExpandedStep in
 * the unified card and renderStep in the dedicated web-search card present
 * identical visuals for the same step descriptors.
 */

import { AlertCircle } from "lucide-react";

import { Typography } from "@vellum/design-library";

import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip";
import type { ToolCallCardStep } from "@/domains/chat/hooks/use-tool-call-card-data";

/**
 * Small "+N more" pill used at the tail of a `web_search` row's result list.
 * Visually matches `FaviconChip` so the overflow pill sits flush in the same
 * row: identical outer geometry (`inline-flex items-center`, 10/6 padding,
 * pill radius, `--surface-base` fill), identical Inter Medium 12 typography
 * (`body-small-default`), and a `min-h-[26px]` floor so the chip matches the
 * favicon chips' natural height (which is dictated by their 14×14 favicon
 * slot inside the same padding).
 */
export function OverflowChip({ count }: { count: number }) {
  return (
    <span className="inline-flex min-h-[26px] items-center rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-[10px] py-[6px]">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-default)]"
      >
        +{count} more
      </Typography>
    </span>
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
 * clamped the visible result count.
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
  return (
    <div className="flex flex-wrap items-center gap-1">
      {step.results.map((r) => (
        <FaviconChip
          key={r.rank}
          faviconUrl={r.faviconUrl}
          title={r.title}
          domain={r.domain}
        />
      ))}
      {step.overflow && step.overflow > 0 ? (
        <OverflowChip count={step.overflow} />
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
