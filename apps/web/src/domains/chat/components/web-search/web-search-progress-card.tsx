
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";

import { Typography } from "@vellum/design-library";

import type { WebSearchResultItem } from "@/assistant/web-activity-types.js";
import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip.js";
import { StepRow } from "@/domains/chat/components/web-search/step-row.js";
import { ThinkingChip } from "@/domains/chat/components/web-search/thinking-chip.js";
import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel.js";
import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell.js";

/**
 * Live progress card rendered while an assistant turn is actively searching the
 * web. Composes the smaller web-search primitives:
 *
 *   - `ToolProgressCardShell` (rounded card + status indicator + header
 *     carousel + expand/collapse body — shared with other tool progress cards)
 *   - `StepRow` (expanded: per-sub-step header with check icon + duration meta)
 *   - `ThinkingChip` (expanded: a thinking step's content)
 *   - `FaviconChip` (expanded: a web_search step's result chips)
 *   - `WebsiteCarousel` (collapsed-header info slot during an active search
 *     with at least one completed `web_search` to feed the rotation)
 *
 * Matches Figma node 4922:103991. Pure presentational — no awareness of the
 * turn state machine. Wires up via the `useWebSearchCardData` selector hook
 * that derives `StepDescriptor[]` plus the per-step header tuple from live
 * tool-call activity metadata.
 *
 * Toggling between collapsed and expanded states honours
 * `prefers-reduced-motion` (height animation snaps when the user opts out)
 * via the shared `ToolProgressCardShell`.
 */

/**
 * A single sub-step inside the expanded card. Discriminated by `kind`:
 * - `"thinking"` → renders a `ThinkingChip` with `text` as its body.
 * - `"web_search"` → renders one `FaviconChip` per result (up to the supplied
 *   list) followed by an optional `+N more` overflow chip when `overflow > 0`.
 *   `title` is supplied by the selector so the row label can switch between
 *   "Searching the web" (in-flight) and "Searched the web" (terminal).
 * - `"web_search_error"` → renders a red AlertCircle + the provider's
 *   `errorMessage` inside a negatively-toned chip. Used when the search
 *   itself failed and there are no results to surface.
 *
 * The plan reserves richer `web_fetch` rendering for a follow-up; the PR-8
 * selector currently maps fetches to a `thinking` step ("Reading <title>").
 */
export type StepDescriptor =
  | { kind: "thinking"; durationLabel: string; text: string }
  | {
      kind: "web_search";
      title: string;
      durationLabel: string;
      linkCount: number;
      results: WebSearchResultItem[];
      overflow?: number;
    }
  | {
      kind: "web_search_error";
      title: string;
      durationLabel: string;
      errorMessage: string;
    };

export interface WebSearchProgressCardProps {
  /**
   * Per-step headline label rendered in the collapsed header. Animates in /
   * out via the card's step carousel as new steps stream in. Reflects the
   * most recent step's own row title (e.g. "Searching the web" → "Searched
   * the web" once the call finalises).
   */
  currentStepTitle: string;
  /**
   * Per-step secondary descriptor (gray text after the title). Animates in
   * sync with `currentStepTitle`. Content depends on the active step — see
   * `WebSearchCardData.currentStepInfo` for the full table of values.
   */
  currentStepInfo: string;
  /** Pre-formatted step count for the toggle pill, e.g. "2 steps". */
  stepCount: string;
  /** Ordered sub-steps to render when expanded. */
  steps: StepDescriptor[];
  /** Whether the card starts expanded. Uncontrolled by default. */
  defaultExpanded?: boolean;
  /**
   * Drives the header chrome:
   * - `"loading"` (default) → animated `ThreeDotIndicator` + rotating
   *   `WebsiteCarousel` in the collapsed header.
   * - `"complete"` → static green `CheckCircle2` icon + no carousel; the
   *   card is rendering a finished search result set.
   */
  state?: "loading" | "complete";
  /**
   * Optional websites to feed the collapsed-header rotating carousel.
   * When non-empty AND `state === "loading"`, the info slot in the header
   * swaps from text (`currentStepInfo`) to a `WebsiteCarousel` rotating
   * through these favicon + title chips. Empty → text mode stays.
   *
   * Populated by `useWebSearchCardData` from the most recently completed
   * `web_search`'s results — see `WebSearchCardData.carouselItems` for the
   * derivation contract.
   */
  carouselItems?: WebSearchResultItem[];
}

/**
 * Small "+N more" pill used at the tail of a `web_search` row's result list.
 * Mirrors Figma node 4922:104082 — filled `--surface-base` pill with the
 * `body-small-emphasised` (Semi Bold 12) typography variant.
 */
function OverflowChip({ count }: { count: number }) {
  return (
    <div className="rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-[10px] py-[6px]">
      <Typography
        variant="body-small-emphasised"
        className="text-[var(--content-default)]"
      >
        +{count} more
      </Typography>
    </div>
  );
}

/**
 * Negatively-toned chip used inside a `web_search_error` step row to
 * surface the provider's `errorMessage`. Mirrors `ThinkingChip`'s outlined
 * pill geometry but swaps the border + foreground tokens for the
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
 * Stable empty-array reference used as the `carouselItems` default. Avoids
 * a fresh `[]` per render that would needlessly tick the
 * `useCarousel` boolean back and forth (and remount `WebsiteCarousel`).
 */
const EMPTY_CAROUSEL_ITEMS: WebSearchResultItem[] = [];

export function WebSearchProgressCard({
  currentStepTitle,
  currentStepInfo,
  stepCount,
  steps,
  defaultExpanded = false,
  state = "loading",
  carouselItems = EMPTY_CAROUSEL_ITEMS,
}: WebSearchProgressCardProps) {
  // Carousel mode supersedes text mode in the collapsed-header info slot,
  // but only during the active search — `complete` state stays text-only so
  // the final-result title reads as the resting visual.
  const useCarousel = state === "loading" && carouselItems.length > 0;

  // Memoise the carousel JSX so the shell's header throttle treats it as
  // stable across parent renders. Without this, a fresh element identity
  // each render would push pending updates into the throttle continuously.
  const carouselNode = useMemo(
    () =>
      useCarousel ? <WebsiteCarousel items={carouselItems} /> : null,
    [useCarousel, carouselItems],
  );

  const headerInfo = useCarousel ? carouselNode : currentStepInfo;

  const shellState: ToolProgressCardState =
    state === "complete" ? "complete" : "loading";

  return (
    <ToolProgressCardShell
      data-testid="web-search-progress-card"
      statusIndicatorTestId="web-search-status-indicator"
      state={shellState}
      currentStepTitle={currentStepTitle}
      currentStepInfo={headerInfo}
      stepCount={stepCount}
      defaultExpanded={defaultExpanded}
    >
      <div className="flex w-full flex-col gap-3 px-3 pb-3">
        {steps.map((step, idx) => {
          if (step.kind === "thinking") {
            return (
              <StepRow
                key={idx}
                title="Thinking"
                durationLabel={step.durationLabel}
              >
                <ThinkingChip>{step.text}</ThinkingChip>
              </StepRow>
            );
          }
          if (step.kind === "web_search_error") {
            return (
              <StepRow
                key={idx}
                title={step.title}
                durationLabel={step.durationLabel}
                tone="error"
              >
                <ErrorChip message={step.errorMessage} />
              </StepRow>
            );
          }
          return (
            <StepRow
              key={idx}
              title={step.title}
              durationLabel={step.durationLabel}
              linkCount={step.linkCount}
            >
              {step.results.map((r) => (
                // Key by `rank` (the documented uniqueness invariant
                // on `WebSearchResultItem`) rather than `url` —
                // providers occasionally return duplicate URLs, which
                // would collide as React keys and cause stale/missing
                // chips during live updates.
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
            </StepRow>
          );
        })}
      </div>
    </ToolProgressCardShell>
  );
}
