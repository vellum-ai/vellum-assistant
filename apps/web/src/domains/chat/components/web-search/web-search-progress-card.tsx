
import { useMemo } from "react";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import {
  DefaultStepPill,
  PhaseGroupedStepList,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

/**
 * Live progress card rendered while an assistant turn is actively searching the
 * web. Composes the smaller web-search primitives:
 *
 *   - `ToolProgressCardShell` (rounded card + status indicator + header
 *     carousel + expand/collapse body — shared with other tool progress cards)
 *   - `PhaseGroupedStepList` (expanded: phase-section headers + indented
 *     per-step content; the web card passes a `renderStep` override so
 *     `web_search` steps keep their favicon-chip cluster)
 *   - `WebSearchStepRow` / `WebSearchErrorRow` (shared with the unified
 *     `MultiActivityGroup`'s `ExpandedStep` — single source of truth for
 *     the favicon chip cluster, overflow pill, and error chip)
 *   - `WebsiteCarousel` (collapsed-header info slot during an active search
 *     with at least one completed `web_search` to feed the rotation)
 *
 * Matches Figma node 4922:103991. Pure presentational — no awareness of the
 * turn state machine. Wires up via the unified `useToolCallCardData` selector
 * hook that derives `StepDescriptor[]` plus the per-step header tuple from
 * live tool-call activity metadata.
 *
 * Toggling between collapsed and expanded states honours
 * `prefers-reduced-motion` (height animation snaps when the user opts out)
 * via the shared `ToolProgressCardShell`.
 */

/**
 * A single sub-step inside the expanded card. Discriminated by `kind`:
 * - `"thinking"` → renders the step's text inside the default phase pill.
 * - `"web_search"` → renders one `FaviconChip` per result (up to the supplied
 *   list) followed by an optional `+N more` overflow pill when
 *   `overflowResults` is non-empty. The pill opens a popover listing those
 *   additional sources as links. `title` is supplied by the selector so the
 *   phase header label can switch between "Searching the web" (in-flight) and
 *   "Searched the web" (terminal).
 * - `"web_search_error"` → renders an `ErrorChip` with the provider's
 *   `errorMessage`. Used when the search itself failed and there are no
 *   results to surface.
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
      overflowResults?: WebSearchResultItem[];
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
   * `ToolCallCardData.currentStepInfo` for the full table of values.
   */
  currentStepInfo: string;
  /** Pre-formatted step count for the toggle pill, e.g. "2 steps". */
  stepCount: string;
  /** Ordered sub-steps to render when expanded. */
  steps: StepDescriptor[];
  /** Whether the card starts expanded. Uncontrolled by default. */
  defaultExpanded?: boolean;
  /** Controlled expanded value. Pairs with `onExpandChange`. */
  expanded?: boolean;
  /** Notified when the user toggles the expand/collapse button. */
  onExpandChange?: (next: boolean) => void;
  /**
   * Drives the header chrome:
   * - `"loading"` (default) → animated `ThreeDotIndicator` + rotating
   *   `WebsiteCarousel` in the collapsed header.
   * - `"complete"` → static green `CheckCircle2` icon + no carousel; the
   *   card is rendering a finished search result set.
   * - `"error"` / `"denied"` → red `AlertCircle` icon + no carousel. Used
   *   by the unified dispatcher when a purely-web group ends with a tool
   *   error or a denied confirmation so the icon matches the chrome
   *   shown for non-web groups.
   */
  state?: ToolProgressCardState;
  /**
   * Optional websites to feed the collapsed-header rotating carousel.
   * When non-empty AND `state === "loading"`, the info slot in the header
   * swaps from text (`currentStepInfo`) to a `WebsiteCarousel` rotating
   * through these favicon + title chips. Empty → text mode stays.
   *
   * Populated by `useToolCallCardData` from the most recently completed
   * `web_search`'s results — see `ToolCallCardData.carouselItems` for the
   * derivation contract.
   */
  carouselItems?: WebSearchResultItem[];
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
  expanded,
  onExpandChange,
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

  return (
    <ToolProgressCardShell
      data-testid="web-search-progress-card"
      statusIndicatorTestId="web-search-status-indicator"
      // `error` / `denied` propagate to the shell's red `AlertCircle` chrome
      // when the unified dispatcher supplies them. The legacy two-value
      // contract (`loading` / `complete`) is still valid by construction.
      state={state}
      currentStepTitle={currentStepTitle}
      currentStepInfo={headerInfo}
      stepCount={stepCount}
      defaultExpanded={defaultExpanded}
      expanded={expanded}
      onExpandChange={onExpandChange}
    >
      <div className="flex w-full flex-col gap-3 px-3 pb-3">
        <PhaseGroupedStepList
          steps={steps as ToolCallCardStep[]}
          renderStep={(step) => {
            if (step.kind === "web_search") {
              return <WebSearchStepRow step={step} />;
            }
            if (step.kind === "web_search_error") {
              return <WebSearchErrorRow step={step} />;
            }
            return <DefaultStepPill step={step} />;
          }}
        />
      </div>
    </ToolProgressCardShell>
  );
}
