/**
 * Compact, expandable phase-grouped timeline for the subagent detail panel.
 *
 * Renders one collapsed row per phase (status node + label + a duration / live
 * activity sub-label + an optional "N steps" pill). Clicking a row with an
 * expandable body toggles its step pills open/closed. Reuses the main-chat
 * timeline's connector/node geometry (see `TimelinePhaseSection` in
 * `phase-grouped-step-list.tsx`) so the panel reads as the same timeline.
 *
 * Pure / presentational: takes only `steps`. The owning panel renders the
 * empty state, so this returns `null` for an empty input.
 */

import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";

import { Typography } from "@vellumai/design-library";

import {
  DefaultStepPill,
  groupStepsByPhase,
  phaseHeaderStatus,
  sumDurationLabels,
  TimelineNode,
  type PhaseSection,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";
import { cn } from "@/utils/misc";

/**
 * Stable per-step key — a tool step's non-empty `toolCallId`, else the
 * positional `${kind}-${index}` fallback. Historical/older subagent events can
 * carry an empty `toolCallId` (see `use-subagent-card-data.ts`), so guarding on
 * a non-empty string keeps keys unique instead of collapsing onto `""`.
 * Shared by the section key and the expanded body's pill list.
 */
function stepKey(step: ToolCallCardStep, index: number): string {
  if (step.kind === "tool" && step.toolCallId) return step.toolCallId;
  return `${step.kind}-${index}`;
}

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

export function SubagentPhaseTimeline({
  steps,
}: {
  steps: ToolCallCardStep[];
}) {
  // Expanded section keys. Default collapsed; the toggler is memoized so
  // already-rendered rows stay referentially stable across toggles.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
}: {
  section: PhaseSection;
  isLast: boolean;
  expanded: boolean;
  sectionKeyValue: string;
  onToggle: (key: string) => void;
}) {
  const status = phaseHeaderStatus(section.steps);
  const isThinking = section.steps[0]?.kind === "thinking";
  const stepCount = section.steps.length;

  // A row is interactive only when it has step pills worth revealing. Rows with
  // a single step carry no separate body, so they render no chevron / toggle.
  const isExpandable = stepCount >= 2;

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
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      data-testid="subagent-phase-section"
      data-phase-label={section.label}
      className="relative flex flex-col gap-2"
    >
      {/* Connector line mirroring the main-chat timeline: starts below this
          node and runs to the section bottom, omitted on the last row. */}
      {!isLast && (
        <div
          aria-hidden
          className="absolute bottom-0 left-[6.5px] top-6 w-px bg-[var(--border-element)]"
        />
      )}

      <button
        type="button"
        data-testid="subagent-phase-header"
        disabled={!isExpandable}
        onClick={isExpandable ? () => onToggle(sectionKeyValue) : undefined}
        className={cn(
          "flex w-full items-center gap-2 py-[2px] text-left",
          isExpandable && "cursor-pointer",
        )}
      >
        <TimelineNode status={status} isThinking={isThinking} />
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-default)]"
        >
          {section.label}
        </Typography>

        {hasTrailingDetail && (
          <span
            aria-hidden
            className="text-[var(--content-tertiary)] opacity-10"
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
            className="truncate text-[var(--content-tertiary)]"
          >
            {`Worked for ${totalDuration}`}
          </Typography>
        ) : null}

        {isExpandable && (
          <span className="ml-auto flex items-center gap-1">
            <Chevron
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            />
            <span
              data-testid="subagent-phase-step-count"
              className="rounded-[100px] bg-[var(--surface-base)] px-1.5 py-1"
            >
              <Typography
                variant="body-small-default"
                className="text-[var(--content-secondary)]"
              >
                {stepCountLabel}
              </Typography>
            </span>
          </span>
        )}
      </button>

      {/* Expanded body: the section's steps as default pills, indented to align
          under the phase title (icon 14px + the row's 8px gap → 22px). */}
      {isExpandable && expanded && (
        <div className="flex flex-col items-start gap-1 pb-3 pl-[22px]">
          {section.steps.map((step, stepIdx) => (
            <DefaultStepPill key={stepKey(step, stepIdx)} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}
