
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button, Typography } from "@vellum/design-library";

import type { WebSearchResultItem } from "@/assistant/web-activity-types.js";
import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip.js";
import { StepRow } from "@/domains/chat/components/web-search/step-row.js";
import { ThinkingChip } from "@/domains/chat/components/web-search/thinking-chip.js";
import { ThreeDotIndicator } from "@/domains/chat/components/web-search/three-dot-indicator.js";
import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel.js";

/**
 * Live progress card rendered while an assistant turn is actively searching the
 * web. Composes the smaller web-search primitives:
 *
 *   - `ThreeDotIndicator` (collapsed header dots + "Finalizing" sub-row dots)
 *   - `HeaderStepCarousel` (animated step title + info — collapsed and expanded)
 *   - `StepRow` (expanded: per-sub-step header with check icon + duration meta)
 *   - `ThinkingChip` (expanded: a thinking step's content)
 *   - `FaviconChip` (expanded: a web_search step's result chips)
 *
 * Matches Figma node 4922:103991. Pure presentational — no awareness of the
 * turn state machine. Wires up via the `useWebSearchCardData` selector hook
 * that derives `StepDescriptor[]` plus the per-step header tuple from live
 * tool-call activity metadata.
 *
 * Toggling between collapsed and expanded states honours
 * `prefers-reduced-motion` — the height animation snaps when the user opts out.
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
 * Minimum dwell time (ms) for each step shown in the header carousel.
 *
 * Without this, fast-arriving streamed updates (Anthropic-native can emit
 * multiple result deltas inside ~100ms) would flash past as a blur. The
 * throttle hook below queues newer values and lands on the latest one
 * once the previous has been on-screen long enough to register.
 */
const HEADER_STEP_MIN_DWELL_MS = 400;

/**
 * Stable empty-array reference used as the `carouselItems` default. Avoids
 * a fresh `[]` per render that would needlessly tick the
 * `useCarousel` boolean back and forth (and remount `WebsiteCarousel`).
 */
const EMPTY_CAROUSEL_ITEMS: WebSearchResultItem[] = [];

/**
 * Latch a value to its previous render until at least `minDwellMs` has
 * elapsed, then update to the latest pending value. Multiple updates inside
 * the window collapse into the final one — last value always wins.
 *
 * Used to throttle the header step (title + info tuple) so the user can
 * actually read each step before it transitions out, regardless of how
 * fast the daemon streams metadata.
 */
function useThrottledValue<T>(value: T, minDwellMs: number): T {
  const [displayed, setDisplayed] = useState(value);
  // `null` sentinel = "not yet initialised". Seeded lazily on the first
  // change so the initial render stays pure (no `Date.now()` during render).
  const lastChangeAt = useRef<number | null>(null);
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Same value as on-screen → nothing to schedule.
    if (Object.is(displayed, value)) {
      pending.current = null;
      return;
    }
    pending.current = value;
    const nowMs = Date.now();
    if (lastChangeAt.current === null) {
      // First swap — anchor the dwell clock to "now" so the very first
      // transition still respects `minDwellMs`.
      lastChangeAt.current = nowMs;
    }
    const elapsed = nowMs - lastChangeAt.current;
    const wait = Math.max(0, minDwellMs - elapsed);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Land on whatever the latest pending value is — newer updates that
      // arrived while we were waiting will have overwritten it.
      if (pending.current !== null) {
        setDisplayed(pending.current);
        lastChangeAt.current = Date.now();
        pending.current = null;
      }
      timer.current = null;
    }, wait);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, displayed, minDwellMs]);

  return displayed;
}

/**
 * Animated tuple of (currentStepTitle, currentStepInfo) rendered inside
 * the collapsed header. Both texts animate together via a single
 * `AnimatePresence` keyed on the tuple identity so the title + subtext
 * never desync mid-transition.
 *
 * Variants mirror `WebsiteCarousel`'s recipe (top-down slide + opacity
 * fade) so the card-wide motion vocabulary stays consistent. Slightly
 * tighter `duration` since text labels feel snappier than chip swaps.
 *
 * Honours `prefers-reduced-motion` — falls back to an opacity-only fade
 * with duration 0.
 */
function HeaderStepCarousel({
  currentStepTitle,
  currentStepInfo,
}: {
  currentStepTitle: string;
  currentStepInfo: string;
}) {
  const reduce = useReducedMotion();
  const tuple = useMemo(
    () => ({ title: currentStepTitle, info: currentStepInfo }),
    [currentStepTitle, currentStepInfo],
  );
  const displayed = useThrottledValue(tuple, HEADER_STEP_MIN_DWELL_MS);

  const transition = reduce
    ? { duration: 0 }
    : {
        duration: 0.25,
        ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      };
  const initial = reduce ? { opacity: 0 } : { y: -16, opacity: 0 };
  const animate = reduce ? { opacity: 1 } : { y: 0, opacity: 1 };
  const exit = reduce ? { opacity: 0 } : { y: 16, opacity: 0 };

  // Stable per-frame key so identical sequential tuples don't trigger a
  // wasted transition.
  const key = `${displayed.title}::${displayed.info}`;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={key}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={transition}
        // Header layout — flex row, title is shrink-0 + nowrap, info
        // truncates inside the remaining space. The pipe separator only
        // renders when there's info to follow it so an empty info doesn't
        // leave a dangling divider.
        className="flex min-w-0 flex-1 items-center gap-1"
      >
        <Typography
          variant="body-medium-default"
          className="ml-1 shrink-0 whitespace-nowrap text-[var(--content-emphasised)]"
        >
          {displayed.title}
        </Typography>
        {displayed.info ? (
          <>
            <span
              aria-hidden="true"
              className="shrink-0 text-[var(--content-tertiary)] opacity-10"
            >
              |
            </span>
            <Typography
              variant="body-small-default"
              className="block min-w-0 flex-1 truncate text-left text-[var(--content-tertiary)]"
            >
              {displayed.info}
            </Typography>
          </>
        ) : null}
      </motion.span>
    </AnimatePresence>
  );
}

/**
 * Header layout used when the carousel feed is non-empty during an active
 * search. Mirrors `HeaderStepCarousel`'s flex shell so the title hugs the
 * left, the dimmed pipe separator follows, and the carousel fills the
 * remaining width.
 *
 * The title text isn't tuple-throttled here because — in carousel mode —
 * the only meaningful title transition is `Searching → Searched` (which
 * only occurs once the carousel hands off back to text mode on
 * `state === "complete"`). The carousel itself owns the rotation animation.
 */
function HeaderTitleWithCarousel({
  currentStepTitle,
  carouselItems,
}: {
  currentStepTitle: string;
  carouselItems: WebSearchResultItem[];
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <Typography
        variant="body-medium-default"
        className="ml-1 shrink-0 whitespace-nowrap text-[var(--content-emphasised)]"
      >
        {currentStepTitle}
      </Typography>
      <span
        aria-hidden="true"
        className="shrink-0 text-[var(--content-tertiary)] opacity-10"
      >
        |
      </span>
      <span className="block min-w-0 flex-1">
        <WebsiteCarousel items={carouselItems} />
      </span>
    </span>
  );
}

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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const reduce = useReducedMotion();

  const transition = reduce
    ? { duration: 0 }
    : { duration: 0.25, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] };

  return (
    // Hover ownership lives on the inner Button. Padding ownership lives on
    // the inner Button (header) and the steps section (when expanded) — the
    // outer wrapper provides only the card chrome (border, radius, base bg)
    // and no padding of its own. The Button's `rounded-*` is conditional so
    // its hover bg paints into the correct corners without clipping its
    // focus ring (overflow:hidden on the wrapper would clip the ring):
    //   - Collapsed: the Button IS the whole card content → fully rounded.
    //   - Expanded: the Button is just the header → rounded only on top so
    //     the divider + steps section flow flush below.
    <div
      data-testid="web-search-progress-card"
      className="flex w-full flex-col rounded-[var(--radius-lg)] border-b border-[var(--border-base)] bg-[var(--surface-overlay)]"
    >
      {/* The entire row is the toggle — clicking the label cluster, dots,
          subtext, or pill expands / collapses. The step-count pill is a
          visual-only <span>; the surrounding Button already provides the
          interactive semantics. */}
      <Button
        variant="ghost"
        size="compact"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse steps" : "Expand steps"}
        onClick={() => setExpanded((v) => !v)}
        className={`h-auto w-full min-w-0 justify-between gap-2 p-3 ${
          expanded
            ? "rounded-t-[var(--radius-lg)] rounded-b-none"
            : "rounded-[var(--radius-lg)]"
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          {state === "complete" ? (
            <CheckCircle2
              data-testid="web-search-status-indicator"
              aria-hidden="true"
              className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
            />
          ) : (
            <ThreeDotIndicator
              data-testid="web-search-status-indicator"
              className="shrink-0"
            />
          )}
          {/* Header info slot.
              - Carousel mode (loading + at least one completed search):
                static title + a `WebsiteCarousel` rotating through the most
                recent search's favicon-title chips. The carousel handles its
                own rotation animation independently of the per-step text
                carousel below.
              - Text mode (default): the existing throttled tuple animation
                slides through `(title, info)` as new steps stream in. */}
          {useCarousel ? (
            <HeaderTitleWithCarousel
              currentStepTitle={currentStepTitle}
              carouselItems={carouselItems}
            />
          ) : (
            <HeaderStepCarousel
              currentStepTitle={currentStepTitle}
              currentStepInfo={currentStepInfo}
            />
          )}
        </span>
        <span className="flex shrink-0 items-center rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-[6px] py-[4px]">
          <Typography
            variant="body-small-default"
            className="text-[var(--content-emphasised)]"
          >
            {stepCount}
          </Typography>
        </span>
      </Button>

      {/* Expanded body — divider + step rows. Animated height-collapse honors
          prefers-reduced-motion (snap when reduced via 0-duration transition). */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="expanded-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2">
              <div className="h-px w-full bg-[var(--surface-base)]" />
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
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
