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

import { Brain } from "lucide-react";
import { useCallback, useState } from "react";

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
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
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
 * Live activity sub-label for a running phase: the `activity` of the last
 * still-running tool step, falling back to that step's `info`, then to the
 * phase label so the row never reads blank.
 */
function runningActivity(section: PhaseSection): string {
  for (let i = section.steps.length - 1; i >= 0; i--) {
    const step = section.steps[i]!;
    if (step.kind === "tool" && step.status === "running") {
      return step.activity || step.info || section.label;
    }
  }
  return section.label;
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
  return undefined;
}

export function SubagentPhaseTimeline({
  steps,
  onStepDetailClick,
  expandedKeys,
  onExpandedKeysChange,
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
  onExpandedKeysChange?: (next: Set<string>) => void;
}) {
  // Expanded section keys. Controlled by the parent when `expandedKeys` is
  // supplied (so the state outlives an unmount); otherwise managed internally.
  // Default collapsed.
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    new Set(),
  );
  const expanded = expandedKeys ?? internalExpanded;
  const toggle = useCallback(
    (key: string) => {
      if (onExpandedKeysChange) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onExpandedKeysChange(next);
        return;
      }
      setInternalExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [expanded, onExpandedKeysChange],
  );

  if (steps.length === 0) return null;
  const sections = groupStepsByPhase(steps);

  return (
    <div className="flex w-full flex-col">
      {sections.map((section, index) => {
        const key = sectionKey(section, index);
        return (
          <SubagentPhaseRow
            key={key}
            section={section}
            isLast={index === sections.length - 1}
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

function SubagentPhaseRow({
  section,
  isLast,
  expanded,
  sectionKeyValue,
  onToggle,
  onStepDetailClick,
}: {
  section: PhaseSection;
  isLast: boolean;
  expanded: boolean;
  sectionKeyValue: string;
  onToggle: (key: string) => void;
  onStepDetailClick?: (detailKey: string) => void;
}) {
  const status = phaseHeaderStatus(section.steps);
  const isThinking = section.steps[0]?.kind === "thinking";
  const stepCount = section.steps.length;

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
  const activity = status === "running" ? runningActivity(section) : "";
  // Whether a trailing detail (activity or duration) follows the label — the
  // faint `|` separator only renders when one does.
  const hasTrailingDetail = status === "running" || Boolean(totalDuration);
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

        <TimelineNode status={status} isThinking={isThinking} />
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

        {status === "running" ? (
          <span className="flex min-w-0 items-center gap-1">
            <Brain
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            />
            <Typography
              variant="body-small-default"
              className="min-w-0 truncate text-[var(--content-tertiary)]"
            >
              {activity}
            </Typography>
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
            className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-[var(--surface-base)] px-2 py-0.5"
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
      {isExpandable && expanded && (
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
                    riskLevel={step.riskLevel}
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
            }
            return <DefaultStepPill key={stepKey(step, stepIdx)} step={step} />;
          })}
        </div>
      )}
    </div>
  );
}
