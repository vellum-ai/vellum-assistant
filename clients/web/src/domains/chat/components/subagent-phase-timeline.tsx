/**
 * Compact, expandable phase-grouped timeline for the subagent detail panel.
 *
 * Renders one collapsed row per phase: a small timeline bullet (the vertical
 * connector runs between the bullets), then the status icon, the label, a
 * duration / live activity sub-label, and an optional "N steps" pill. Clicking
 * a row with an expandable body toggles its step pills open/closed. Reuses the
 * main-chat timeline's `TimelineConnector` — the bullet's 14px box centres the
 * dot on the connector's `left-[6.5px]` line, so the status icon is no longer
 * the node the line connects (it sits inline after the bullet instead).
 *
 * Pure / presentational: takes only `steps`. The owning panel renders the
 * empty state, so this returns `null` for an empty input.
 */

import { Brain, Globe } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useMemo, useState } from "react";

import { Typography } from "@vellumai/design-library";

import {
  DefaultStepPill,
  groupStepsByPhase,
  phaseHeaderStatus,
  stepKey,
  stepRendersPill,
  sumDurationLabels,
  TimelineConnector,
  TimelineNode,
  type PhaseSection,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";
import { cn } from "@/utils/misc";

/**
 * Stable key for a phase section — its positional index plus its label and the
 * first step's identity. The index keeps two same-labelled sections (e.g. two
 * non-contiguous "Working" phases) distinct even when their first steps share a
 * key (both empty `toolCallId`).
 */
function sectionKey(section: PhaseSection, index: number): string {
  const first = section.steps[0];
  return `${index}-${section.label}-${first ? stepKey(first, index) : ""}`;
}

/**
 * The last still-running step of a phase — a running tool, or an in-flight
 * web_search (whose title is still the present-tense placeholder). Drives the
 * running row's live activity text + leading icon. `undefined` when the phase
 * has no running step.
 */
function runningStep(section: PhaseSection): ToolCallCardStep | undefined {
  for (let i = section.steps.length - 1; i >= 0; i--) {
    const step = section.steps[i]!;
    if (step.kind === "tool" && step.status === "running") return step;
    if (step.kind === "web_search" && step.title === "Searching the web") {
      return step;
    }
  }
  return undefined;
}

/**
 * Live activity sub-label for a running tool phase: the running tool's
 * `activity`/`info`, falling back to the phase label. Search phases derive their
 * trailing label from {@link mostRecentSearchQuery} instead (the query lands
 * with the result, not at call time), so they don't route through here.
 */
function runningActivity(
  step: ToolCallCardStep | undefined,
  fallback: string,
): string {
  if (!step) return fallback;
  if (step.kind === "tool") return step.activity || step.info || fallback;
  return fallback;
}

/**
 * The query of the most recent web_search step in a phase that has one — walked
 * newest-first so an in-flight search (whose query hasn't resolved yet) shows
 * the previous, known query rather than nothing. `undefined` when no search in
 * the phase carries a query. Drives the trailing query shown to the right of the
 * divider for a "Searching the web" phase.
 */
function mostRecentSearchQuery(section: PhaseSection): string | undefined {
  for (let i = section.steps.length - 1; i >= 0; i--) {
    const step = section.steps[i]!;
    if (step.kind === "web_search" && step.query) return step.query;
  }
  return undefined;
}

/**
 * The most recent thinking step's text in a phase, walked newest-first. A
 * "Thinking" phase carries no per-step running status, so when it's the active
 * tail this is the line the subagent is currently on (e.g. "Reading
 * adidas-group.com" — a web_fetch step renders as `thinking`). Drives the
 * trailing carousel for a running Thinking phase, mirroring how a search phase
 * surfaces its query. `undefined` when no thinking step carries text.
 */
function latestThinkingText(section: PhaseSection): string | undefined {
  for (let i = section.steps.length - 1; i >= 0; i--) {
    const step = section.steps[i]!;
    if (step.kind === "thinking" && step.text) return step.text;
  }
  return undefined;
}

/**
 * Detail-map key for a step that can open a nested detail view: a tool step's
 * `toolCallId`, or a thinking step's `detailKey` (stamped by the subagent
 * projection). `undefined` for steps with no detail / no key, which stay
 * non-interactive. Mirrors the keys `buildSubagentStepDetails` emits.
 */
function stepDetailKey(step: ToolCallCardStep): string | undefined {
  if (step.kind === "tool") return step.toolCallId || undefined;
  if (step.kind === "thinking") return step.detailKey;
  if (step.kind === "web_search") return step.detailKey;
  if (step.kind === "web_search_error") return step.detailKey;
  return undefined;
}

export function SubagentPhaseTimeline({
  steps,
  onStepDetailClick,
  expandedKeys,
  onExpandedKeysChange,
  isRunning = false,
}: {
  steps: ToolCallCardStep[];
  /**
   * When supplied, expanded steps that have a detail (tool calls and thinking
   * segments) render as clickable `ToolStepPill` buttons; clicking one calls
   * back with that step's detail key (see `stepDetailKey`). Optional so this
   * component is deploy-safe without a consumer wired up.
   */
  onStepDetailClick?: (detailKey: string) => void;
  /**
   * Controlled expand/collapse state — the set of currently-expanded section
   * keys. When supplied (with `onExpandedKeysChange`), the parent owns this
   * state so it survives the timeline being unmounted (e.g. while a nested tool
   * detail is shown) and is restored on return. When omitted, the component
   * manages the state internally.
   */
  expandedKeys?: Set<string>;
  /**
   * Controlled-expansion setter. Takes a functional updater so the parent can
   * pass a stable `setState`-style setter (React's
   * `Dispatch<SetStateAction<Set<string>>>` satisfies this). Receiving a stable
   * identity here lets `toggle` below stay `useCallback`-stable across
   * expand/collapse, which keeps the memoized rows from all re-rendering on a
   * single toggle.
   */
  onExpandedKeysChange?: (updater: (prev: Set<string>) => Set<string>) => void;
  /**
   * Whether the owning subagent is still active. When `true`, the LAST phase's
   * node keeps pulsing (a `ThreeDotIndicator`) even after its own steps settle,
   * so the timeline reflects ongoing work during the between-steps window —
   * without inventing a separate "Working" row. A separate row would flicker in
   * and out: a same-type next step (e.g. another search) merges back into the
   * last phase, so the interim bullet would appear then vanish. Defaults to
   * `false`. A genuinely different next step opens a new phase row, which then
   * becomes the pulsing tail.
   */
  isRunning?: boolean;
}) {
  // Expanded section keys. Controlled by the parent when `expandedKeys` is
  // supplied (so the state outlives an unmount); otherwise managed internally.
  // Default collapsed.
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    new Set(),
  );
  const expanded = expandedKeys ?? internalExpanded;
  // Both branches toggle via a functional updater, so `toggle` never closes over
  // the current `expanded` set — its identity stays stable across expand/collapse
  // (the parent passes a stable `setState`-style `onExpandedKeysChange`). A
  // stable `toggle` is what lets the memoized `SubagentPhaseRow`s bail on a
  // single toggle instead of all re-rendering.
  const toggle = useCallback(
    (key: string) => {
      const update = (prev: Set<string>): Set<string> => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      };
      if (onExpandedKeysChange) {
        onExpandedKeysChange(update);
        return;
      }
      setInternalExpanded(update);
    },
    [onExpandedKeysChange],
  );

  // Memoized so the O(n) grouping + fresh section allocations don't re-run on
  // renders driven purely by expand/collapse (`expandedKeys`) — only when the
  // step list itself changes. `groupStepsByPhase([])` is `[]`, so the empty
  // check below is equivalent to the prior `steps.length === 0`.
  const sections = useMemo(() => groupStepsByPhase(steps), [steps]);
  if (sections.length === 0) return null;

  return (
    <div className="flex w-full flex-col">
      {sections.map((section, index) => {
        const key = sectionKey(section, index);
        const isLast = index === sections.length - 1;
        return (
          <SubagentPhaseRow
            key={key}
            section={section}
            isLast={isLast}
            // Only the last row keeps pulsing while the subagent runs — so the
            // timeline shows ongoing work without a separate, flicker-prone row.
            isActiveTail={isLast && isRunning}
            expanded={expanded.has(key)}
            sectionKeyValue={key}
            onToggle={toggle}
            onStepDetailClick={onStepDetailClick}
          />
        );
      })}
    </div>
  );
}

// Memoized so a single expand/collapse re-renders only the toggled row and a
// no-op parent re-render re-renders none. The bail relies on every prop being
// reference-stable on those re-renders: `section` (from the stable `sections`
// `useMemo`) and the `onToggle` / `onStepDetailClick` callbacks. A genuine
// `steps` change re-runs `groupStepsByPhase`, producing fresh `section` objects
// that correctly bust the memo for the rows that changed.
const SubagentPhaseRow = memo(function SubagentPhaseRow({
  section,
  isLast,
  isActiveTail,
  expanded,
  sectionKeyValue,
  onToggle,
  onStepDetailClick,
}: {
  section: PhaseSection;
  isLast: boolean;
  /**
   * The last row while the subagent is still running. Keeps the node pulsing
   * after this phase's own steps settle, so the next same-type step merges back
   * in (this row stays the tail) instead of a transient "Working" row flashing.
   */
  isActiveTail: boolean;
  expanded: boolean;
  sectionKeyValue: string;
  onToggle: (key: string) => void;
  onStepDetailClick?: (detailKey: string) => void;
}) {
  const reduce = useReducedMotion();
  const rawStatus = phaseHeaderStatus(section.steps);
  // Only the active tail — the last phase while the subagent is still running —
  // may read as in-flight. Steps are sequential, so any OTHER phase computing
  // "running" is stale: a web_search whose `tool_result` never arrives keeps its
  // present-tense title ("Searching the web") forever, and `phaseHeaderStatus`
  // reports that as running. Left alone it pulses mid-timeline with already
  // settled phases after it (and a terminal subagent would pulse too). Coerce
  // those orphaned "running" phases to "completed" so only the tail can pulse.
  const status =
    rawStatus === "running" && !isActiveTail ? "completed" : rawStatus;
  // The node pulses for the active tail (equivalently, a genuinely running last
  // phase — `status` stays "running" only there after the coercion above). The
  // trailing slot still reflects `status` (query / "Worked for <dur>").
  const nodePulses = status === "running" || isActiveTail;
  const isThinking = section.steps[0]?.kind === "thinking";
  const stepCount = section.steps.length;

  // A "Searching the web" phase surfaces its query to the right of the divider
  // (running or done) instead of a duration / generic activity — that's the
  // most useful thing to show for a search. `searchQuery` is the most recent
  // resolved query in the phase (see the helper); `undefined` until one lands.
  const isSearch = section.label === "Searching the web";
  const searchQuery = isSearch ? mostRecentSearchQuery(section) : undefined;

  // The "N steps" pill only makes sense for a multi-step phase.
  const showStepCount = stepCount >= 2;
  // A row is interactive (the whole row is a pointer-cursor toggle) when at
  // least one step renders a pill in the expanded body, so expanding can never
  // reveal an empty body. That happens two ways: the step renders a
  // `DefaultStepPill` (`stepRendersPill`, its own predicate), OR it renders a
  // clickable `ToolStepPill`. A step with a detail key (a tool call or a
  // thinking segment, with a handler wired) renders a clickable pill even when
  // `stepRendersPill` is false for it — e.g. an info-less tool call, whose pill
  // falls back to `step.title` — so it counts toward expandability too. The
  // clickable arm mirrors the expanded body's render condition below.
  const isExpandable = section.steps.some(
    (step) =>
      stepRendersPill(step) ||
      (Boolean(onStepDetailClick) && Boolean(stepDetailKey(step))),
  );

  const totalDuration =
    status === "running"
      ? ""
      : sumDurationLabels(
          section.steps.map((s) =>
            "durationLabel" in s ? s.durationLabel : "",
          ),
        );
  const running = status === "running" ? runningStep(section) : undefined;
  // Non-search running phases show the running tool's activity in the trailing
  // slot; search phases use `searchTrailing` (their query) instead — see below.
  const activity =
    status === "running" && !isSearch
      ? runningActivity(running, section.label)
      : "";
  // A search phase shows its query in the trailing slot whenever it's running
  // OR has a resolved query — running or done, so the SAME animated carousel
  // renders in both states. That keeps the animation alive as a multi-search
  // phase flips between in-flight and settled: newer queries slide in instead of
  // a component swap (carousel ↔ static text) silently dropping the transition.
  // Falls back to the phase label during the brief window before the first
  // query resolves.
  const showSearchTrailing =
    isSearch && (status === "running" || Boolean(searchQuery));
  const searchTrailing = searchQuery ?? section.label;
  // A "Thinking" phase carries no per-step running status, so the active tail is
  // the only signal its latest line is still in progress. While it's the tail,
  // surface that line (e.g. "Reading adidas-group.com") in the trailing slot —
  // mirroring how a search phase surfaces its query — and let the node pulse
  // (see `isThinking && !nodePulses` on the node below). Falls back to the label
  // in the brief window before the first line lands.
  const isThinkingTail = isThinking && nodePulses;
  const thinkingTrailing = isThinkingTail
    ? (latestThinkingText(section) ?? section.label)
    : undefined;
  // Whether a trailing detail (activity, search query, thinking line, or
  // duration) follows the label — the faint `|` separator only renders when one
  // does.
  const hasTrailingDetail =
    status === "running" ||
    showSearchTrailing ||
    isThinkingTail ||
    Boolean(totalDuration);
  const stepCountLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;

  return (
    // Non-last rows reserve 16px below (`pb-4`) so consecutive group rows sit
    // 16px apart; the absolute connector spans this padding to bridge bullets.
    <div
      data-testid="subagent-phase-section"
      data-phase-label={section.label}
      className={cn("relative flex flex-col gap-2", !isLast && "pb-4")}
    >
      {/* No connector trails below the final row. The dot centre sits 11px from
          the row top (the header is pinned to `h-[22px]`; the 14px bullet box
          centres there), dot radius 2.5px. For a uniform 4px gap at
          BOTH ends we start the line 4px below this dot (11 + 2.5 + 4 = 17.5px)
          and end it 4px above the next dot. The next dot is always 11px into the
          following row, which begins at this container's bottom edge, so the
          line must finish 4.5px below that edge (11 − 2.5 − 4 = 4.5) — and since
          that offset is relative to the container bottom it holds whether the
          row is collapsed or expanded. These override the shared connector's
          `top-6` / `bottom-0` defaults via tailwind-merge. */}
      {!isLast && (
        <TimelineConnector className="top-[17.5px] -bottom-[4.5px]" />
      )}

      <button
        type="button"
        data-testid="subagent-phase-header"
        disabled={!isExpandable}
        onClick={isExpandable ? () => onToggle(sectionKeyValue) : undefined}
        // Fixed 22px height (not py-based) so the bullet's centre is ALWAYS 11px
        // from the row top regardless of trailing content. A row with a duration
        // / running activity renders the `|` separator, whose inherited ~16px
        // font + ~1.4 line-height would otherwise grow the row to ~27px and drop
        // the dot ~5px — fusing it with the connector (which is pinned to an
        // 11px dot centre). Pinning the height keeps every row uniform so the
        // connector's 4px end-gaps hold on every row, including the first.
        className={cn(
          "flex h-[22px] w-full items-center gap-2 text-left",
          isExpandable && "cursor-pointer",
        )}
      >
        {/* Timeline bullet — the connector anchor. Its 14px box centres the
            dot under `TimelineConnector`'s vertical line (left-[6.5px]); the
            status icon below is no longer on the line and sits inline. */}
        <span
          aria-hidden
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center"
        >
          <span className="h-[5px] w-[5px] rounded-full bg-[var(--content-disabled)]" />
        </span>

        <TimelineNode
          status={nodePulses ? "running" : status}
          // A thinking phase normally shows a static brain; while it's the
          // active (pulsing) tail, fall through to the running node so it shows
          // the three-dot indicator like every other in-progress phase.
          isThinking={isThinking && !nodePulses}
        />
        <Typography
          variant="body-medium-default"
          className="shrink-0 text-[var(--content-default)]"
        >
          {section.label}
        </Typography>

        {hasTrailingDetail && (
          <span
            aria-hidden
            // `leading-none` caps the bare glyph's line-box: without it the span
            // inherits a ~1.4 line-height that the fixed-height row would have to
            // clip. Belt-and-suspenders with the row's `h-[22px]`.
            className="shrink-0 leading-none text-[var(--content-tertiary)] opacity-10"
          >
            |
          </span>
        )}

        {showSearchTrailing ? (
          // Search phase (running or done): the query in the trailing slot with
          // a globe, animated via the header carousel so newer queries slide in.
          // Replaces "Worked for <dur>" once settled — the query is the useful
          // thing to surface for a search, and matches what the row read as live.
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Globe
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            />
            <HeaderStepCarousel
              currentStepTitle=""
              currentStepInfo={searchTrailing}
            />
          </span>
        ) : isThinkingTail ? (
          // Running "Thinking" tail: its latest line in the trailing slot, with
          // a brain glyph, animated via the same carousel as search/tools. The
          // node renders the three-dot indicator (the brain moves here), so the
          // row reads as actively in progress — e.g. "Reading adidas-group.com".
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Brain
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            />
            <HeaderStepCarousel
              currentStepTitle=""
              currentStepInfo={thinkingTrailing ?? section.label}
            />
          </span>
        ) : status === "running" ? (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Brain
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            />
            {/* Live running activity, animated + throttled via the main-chat
                header carousel so the current task slides/updates in place
                instead of hard-cutting. Empty title — the phase label already
                sits before the separator, so the carousel carries just the
                running tool's activity. */}
            <HeaderStepCarousel currentStepTitle="" currentStepInfo={activity} />
          </span>
        ) : totalDuration ? (
          <Typography
            variant="body-small-default"
            className="min-w-0 truncate text-[var(--content-tertiary)]"
          >
            {`Worked for ${totalDuration}`}
          </Typography>
        ) : null}

        {isExpandable && showStepCount && (
          <span
            data-testid="subagent-phase-step-count"
            // `inline-flex` + `self-stretch` makes the pill fill the grouped
            // row's full height (`h-[22px]`) — `self-stretch` overrides the
            // header's `items-center` for this item — and `items-center` keeps
            // the label vertically centered within it.
            className="ml-auto inline-flex shrink-0 items-center self-stretch whitespace-nowrap rounded-full bg-[var(--surface-base)] px-2"
          >
            <Typography
              variant="body-small-default"
              className="whitespace-nowrap text-[var(--content-secondary)]"
            >
              {stepCountLabel}
            </Typography>
          </span>
        )}
      </button>

      {/* Expanded body: the section's steps as default pills, indented to clear
          the bullet rail and align under the status icon (bullet 14px + the
          row's 8px gap → 22px). No own bottom padding — the container's `pb-4`
          (non-last rows) is the only bottom spacing, so the last pill sits 16px
          from the next group rather than 12px (pb-3) + 16px. */}
      <AnimatePresence initial={false}>
        {isExpandable && expanded && (
          <motion.div
            key="phase-steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }
            }
            className="overflow-hidden"
          >
            <div className="flex flex-col items-start gap-1 pl-[22px]">
              {section.steps.map((step, stepIdx) => {
                // A step with a detail key + a wired handler renders a clickable
                // `ToolStepPill` that opens its nested detail; everything else keeps
                // the non-interactive `DefaultStepPill`.
                const detailKey = onStepDetailClick
                  ? stepDetailKey(step)
                  : undefined;
                if (detailKey && onStepDetailClick) {
                  if (step.kind === "tool") {
                    return (
                      <ToolStepPill
                        key={stepKey(step, stepIdx)}
                        variant="tool"
                        iconName={step.iconName}
                        label={step.activity || step.info || step.title}
                        tone={
                          step.status === "error" || step.status === "denied"
                            ? "error"
                            : "default"
                        }
                        ariaLabel="View tool details"
                        onClick={() => onStepDetailClick(detailKey)}
                      />
                    );
                  }
                  if (step.kind === "thinking") {
                    return (
                      <ToolStepPill
                        key={stepKey(step, stepIdx)}
                        variant="tool"
                        iconName="brain"
                        label={step.text}
                        ariaLabel="View reasoning"
                        onClick={() => onStepDetailClick(detailKey)}
                      />
                    );
                  }
                  if (step.kind === "web_search") {
                    // The search's query becomes a clickable pill; its result
                    // sources move into the nested detail (query + links), mirroring
                    // the thinking-pill → reasoning-detail pattern. Falls back to the
                    // inline query label + chips below when no detail handler is
                    // wired (deploy-safe).
                    return (
                      <ToolStepPill
                        key={stepKey(step, stepIdx)}
                        variant="tool"
                        iconName="globe"
                        label={step.query || step.title}
                        ariaLabel="View search details"
                        onClick={() => onStepDetailClick(detailKey)}
                      />
                    );
                  }
                  if (step.kind === "web_search_error") {
                    // A failed search becomes an error-toned pill that opens the
                    // full, untruncated provider error in the nested detail —
                    // parity with a failed tool. Falls back to the inline error chip
                    // below when no detail handler is wired (deploy-safe).
                    return (
                      <ToolStepPill
                        key={stepKey(step, stepIdx)}
                        variant="tool"
                        iconName="globe"
                        label={step.errorMessage}
                        tone="error"
                        ariaLabel="View search error"
                        onClick={() => onStepDetailClick(detailKey)}
                      />
                    );
                  }
                }
                // Web steps render as their own chip clusters (favicon chips /
                // error chip) rather than the title-only `DefaultStepPill`, matching
                // main chat. `web_search` results are parsed from the tool result by
                // `computeSubagentCardData`.
                if (step.kind === "web_search") {
                  // Label each search with its query so multiple (unclamped)
                  // searches in one "Searching the web" group stay visually
                  // distinct — the "N steps" count then maps to N labelled clusters.
                  return (
                    <div
                      key={stepKey(step, stepIdx)}
                      className="flex w-full flex-col gap-1"
                    >
                      {step.query ? (
                        <Typography
                          variant="body-small-default"
                          className="text-[var(--content-secondary)]"
                        >
                          {`"${step.query}"`}
                        </Typography>
                      ) : null}
                      <WebSearchStepRow step={step} />
                    </div>
                  );
                }
                if (step.kind === "web_search_error") {
                  return (
                    <WebSearchErrorRow
                      key={stepKey(step, stepIdx)}
                      step={step}
                    />
                  );
                }
                return (
                  <DefaultStepPill key={stepKey(step, stepIdx)} step={step} />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
