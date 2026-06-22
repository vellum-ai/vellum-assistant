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

  // The "N steps" pill only makes sense for a multi-step phase.
  const showStepCount = stepCount >= 2;
  // A row is interactive (the whole row is a pointer-cursor toggle) when at
  // least one step actually renders a pill — `stepRendersPill` is
  // `DefaultStepPill`'s own predicate, so expanding can never reveal an empty
  // body. A lone info-less tool step (successful or failed) renders no pill, so
  // it stays non-expandable.
  const isExpandable = section.steps.some(stepRendersPill);

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
    <div
      data-testid="subagent-phase-section"
      data-phase-label={section.label}
      className="relative flex flex-col gap-2"
    >
      {/* No connector trails below the final row. `-bottom-2` extends the line
          lower than the main-chat default so the gap between segments is
          tighter (the timeline still reads as segments, just closer together). */}
      {!isLast && <TimelineConnector className="-bottom-2" />}

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
        {/* Timeline bullet — the connector anchor. Its 14px box centres the
            dot under `TimelineConnector`'s vertical line (left-[6.5px]); the
            status icon below is no longer on the line and sits inline. */}
        <span
          aria-hidden
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center"
        >
          <span className="h-2 w-2 rounded-full bg-[var(--content-disabled)]" />
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
            className="shrink-0 text-[var(--content-tertiary)] opacity-10"
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
          row's 8px gap → 22px). */}
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
