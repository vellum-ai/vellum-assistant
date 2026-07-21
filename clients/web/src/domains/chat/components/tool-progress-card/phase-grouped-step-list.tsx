/**
 * Phase-grouped step list for the expanded body of the unified tool-call
 * progress card. Collapses contiguous same-phase steps under a single
 * phase header row (with the section's status icon + total duration) and
 * renders each step beneath the header as a pill chip.
 *
 * Matches Figma node `5010-103135` — per-phase header + indented pill rows,
 * no priority pills (the daemon doesn't surface High/Low priority signals
 * today; deferred per the unify-tool-cards plan).
 *
 * Pure presentational. Drives all three consumers of the unified card
 * (web search, unified tool group, inline subagent) so the visual language
 * stays consistent. Callers that need per-kind chip overrides (e.g. the
 * web-search card preserving its favicon chips) supply a `renderStep`
 * function to bypass the default pill rendering for that step.
 */

import {
  Bolt,
  Brain,
  Check,
  CheckCircle2,
  Code,
  FileText,
  Globe,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  SquareTerminal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Tooltip, Typography } from "@vellumai/design-library";

import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import {
  formatMs,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { cn } from "@/utils/misc";

/** Concrete lucide icon for each `IconName` produced by `deriveStepLabel`. */
export const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  terminal: SquareTerminal,
  file: FileText,
  globe: Globe,
  pen: Pen,
  monitor: Monitor,
  plug: Plug,
  sparkle: Sparkles,
  "user-plus": UserPlus,
  bolt: Bolt,
  brain: Brain,
};

/**
 * Derive the human-readable phase label for a step. Contiguous steps that
 * share the same label collapse into a single `PhaseSection`.
 *
 * `tool` branch:
 *   - "Working" (bash) and other "Working (...)" titles → kept verbatim
 *   - "Reading" / "Editing" / "Running ..." → grouped under "Working"
 *   - "Using a skill" → kept verbatim
 *   - "Using ..." (MCP / server) → kept verbatim (server name is the label)
 *   - Any other title falls back to the title itself so unrecognized tools
 *     still produce a sensible section heading.
 */
export function phaseFromStep(step: ToolCallCardStep): string {
  if (step.kind === "thinking") return "Thinking";
  if (step.kind === "web_search" || step.kind === "web_search_error") {
    return "Searching the web";
  }
  if (step.kind === "tool_error") return "Error";
  // step.kind === "tool"
  const title = step.title;
  if (title.startsWith("Working")) return title;
  if (
    title === "Reading" ||
    title === "Editing" ||
    title.startsWith("Running")
  ) {
    return "Working";
  }
  if (title === "Using a skill") return "Using a skill";
  if (title.startsWith("Using ")) return title;
  return title;
}

/**
 * Best-effort parse of a `formatMs`-style duration label back into a raw ms
 * value so we can sum phase totals. Handles every output the formatter
 * produces (`"<1s"`, `"Ns"`, `"Nm"`, `"Nh"`) plus an empty / missing label.
 * Re-formatting the sum via `formatMs` collapses the coarse units back into a
 * single readable label, so the per-unit rounding here is acceptable.
 */
function parseDurationLabel(label: string): number {
  if (!label || label === "<1s") return 0;
  const match = /^(\d+)(s|m|h)$/.exec(label);
  if (!match) return 0;
  const value = Number(match[1]);
  switch (match[2]) {
    case "h":
      return value * 3_600_000;
    case "m":
      return value * 60_000;
    default:
      return value * 1_000;
  }
}

/**
 * Earliest known start time (epoch ms) across a phase's steps, or `null` when
 * none carry timing. Both `tool` and `thinking` steps stamp `startedAt`, so a
 * thinking phase surfaces the same "Started at …" hover on its duration as a
 * tool phase.
 */
function phaseStartedAt(steps: ToolCallCardStep[]): number | null {
  let earliest: number | null = null;
  for (const step of steps) {
    if (
      (step.kind === "tool" || step.kind === "thinking") &&
      step.startedAt != null
    ) {
      earliest =
        earliest == null ? step.startedAt : Math.min(earliest, step.startedAt);
    }
  }
  return earliest;
}

/** Format an epoch-ms timestamp as a local clock time for the duration tooltip. */
function formatStartTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Phase duration label. When the phase carries a known start time, the duration
 * becomes a tooltip trigger — hovering "3s" reveals when the work began.
 */
function PhaseDurationLabel({
  durationLabel,
  startedAt,
}: {
  durationLabel: string;
  startedAt: number | null;
}) {
  const label = (
    <Typography
      variant="label-medium-default"
      className="text-[var(--content-tertiary)]"
    >
      {durationLabel}
    </Typography>
  );
  if (startedAt == null) return label;
  return (
    <Tooltip
      content={`Started at ${formatStartTime(startedAt)}`}
      side="top"
      align="end"
    >
      <span className="cursor-default">{label}</span>
    </Tooltip>
  );
}

/** Total of `formatMs`-style labels, re-formatted via `formatMs`. */
export function sumDurationLabels(labels: string[]): string {
  let total = 0;
  let anyPresent = false;
  for (const label of labels) {
    if (!label) continue;
    anyPresent = true;
    total += parseDurationLabel(label);
  }
  if (!anyPresent) return "";
  return formatMs(total);
}

/** Header status states a phase can render. */
type PhaseHeaderStatus = "completed" | "running";

/**
 * Classify a phase's overall status for header icon rendering: any running
 * step → "running"; otherwise → "completed". Failures (`tool_error` /
 * `web_search_error` / `tool` status `error`|`denied`) intentionally read as
 * "completed" — error chrome carries no value for the user, so settled phases
 * all render the same regardless of outcome.
 *
 * `web_search` steps carry no explicit status field — `useToolCallCardData`
 * encodes "in-flight" via the present-tense title ("Searching the web" vs
 * "Searched the web"), so we treat any `web_search` step with that title
 * as in-flight. `thinking` is always neutral (no in-flight signal carried).
 */
export function phaseHeaderStatus(
  steps: ToolCallCardStep[],
): PhaseHeaderStatus {
  if (steps.length === 0) return "running";
  for (const step of steps) {
    if (step.kind === "tool") {
      if (step.status === "running") return "running";
      continue;
    }
    if (step.kind === "web_search") {
      // Title is the canonical in-flight signal — see `webSearchStepTitle`
      // in `use-tool-call-card-data.ts`.
      if (step.title === "Searching the web") return "running";
    }
  }
  return "completed";
}

/** Phase-grouped section as consumed by the renderer. */
export interface PhaseSection {
  label: string;
  steps: ToolCallCardStep[];
}

/** Collapse contiguous same-phase steps into sections preserving order. */
export function groupStepsByPhase(steps: ToolCallCardStep[]): PhaseSection[] {
  const sections: PhaseSection[] = [];
  for (const step of steps) {
    const label = phaseFromStep(step);
    const last = sections[sections.length - 1];
    if (last && last.label === label) {
      last.steps.push(step);
    } else {
      sections.push({ label, steps: [step] });
    }
  }
  return sections;
}

export interface PhaseGroupedStepListProps {
  steps: ToolCallCardStep[];
  /**
   * Optional per-step renderer. When omitted, each step renders as the
   * default pill chip (icon + truncated info). The web-search consumer
   * passes a renderer that preserves the favicon / overflow / error chips.
   */
  renderStep?: (step: ToolCallCardStep) => ReactNode;
  /**
   * When `true`, render the sections as a vertical timeline: each phase's
   * status icon sits in a left node column with a connector line running
   * continuously down to the next phase's icon, and the header + steps flow
   * in a right content column. Defaults to `false`, in which case the list
   * renders exactly as before (flat phase-header rows + `pl-[24px]`-indented
   * step pills) — the web-search and subagent inline cards rely on this
   * unchanged layout.
   */
  timeline?: boolean;
}

export function PhaseGroupedStepList({
  steps,
  renderStep,
  timeline = false,
}: PhaseGroupedStepListProps) {
  if (steps.length === 0) return null;
  const sections = groupStepsByPhase(steps);

  // Pre-compute the global-index offset for each section so we don't
  // need a mutable counter during render.
  const sectionOffsets: number[] = [];
  let offset = 0;
  for (const section of sections) {
    sectionOffsets.push(offset);
    offset += section.steps.length;
  }

  const renderSectionSteps = (
    section: PhaseSection,
    baseIndex: number,
  ): ReactNode =>
    section.steps.map((step, stepIdx) => {
      const key = stepKey(step, baseIndex + stepIdx);
      return (
        <Fragment key={key}>
          {renderStep ? renderStep(step) : <DefaultStepPill step={step} />}
        </Fragment>
      );
    });

  // Timeline mode: a vertical run of circular status nodes joined by a
  // continuous connector line, each paired with its phase header + steps in a
  // right-hand content column. The list owns no inter-section `gap` — each
  // non-last `TimelinePhaseSection` carries its own `pb-3` so the connector
  // line runs unbroken from one circle down to the next (a list-level `gap`
  // would split the line into visible segments between circles).
  if (timeline) {
    return (
      <div className="flex w-full flex-col">
        {sections.map((section, sectionIdx) => (
          <TimelinePhaseSection
            key={`${section.label}-${sectionIdx}`}
            section={section}
            baseIndex={sectionOffsets[sectionIdx]!}
            isLast={sectionIdx === sections.length - 1}
            renderSectionSteps={renderSectionSteps}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {sections.map((section, sectionIdx) => {
        const totalDuration = sumDurationLabels(
          section.steps.map((s) =>
            "durationLabel" in s ? s.durationLabel : "",
          ),
        );
        const status = phaseHeaderStatus(section.steps);
        const baseIndex = sectionOffsets[sectionIdx];
        return (
          <div
            key={`${section.label}-${sectionIdx}`}
            data-testid="phase-section"
            data-phase-label={section.label}
            className="flex flex-col gap-1"
          >
            <PhaseHeaderRow
              label={section.label}
              durationLabel={totalDuration}
              status={status}
            />
            <div className="flex min-w-0 flex-col items-start gap-1 pl-[24px]">
              {renderSectionSteps(section, baseIndex)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One phase section in the vertical timeline: the connector line, the circular
 * status node, the phase header row, and the indented step pills.
 *
 * Timeline mechanics:
 *  - A connector line per non-last section sits at the node's center x
 *    (`left-[6.5px]`: the 14px icon at the section's left → center ≈ 7px). It
 *    starts BELOW this node (`top-6`) and runs to the section bottom
 *    (`bottom-0`), leaving a small, even gap before the next node — so the
 *    timeline reads as evenly-spaced segments rather than one unbroken line.
 *  - The LAST section renders no line, so nothing trails below the final node.
 *  - The FIRST section renders no lead-in: the expanded card header omits its
 *    status icon, so the timeline starts cleanly at the first node rather than
 *    trailing a connector up to empty space.
 */
function TimelinePhaseSection({
  section,
  baseIndex,
  isLast,
  renderSectionSteps,
}: {
  section: PhaseSection;
  baseIndex: number;
  isLast: boolean;
  renderSectionSteps: (section: PhaseSection, baseIndex: number) => ReactNode;
}) {
  const totalDuration = sumDurationLabels(
    section.steps.map((s) => ("durationLabel" in s ? s.durationLabel : "")),
  );
  const status = phaseHeaderStatus(section.steps);
  // A thinking phase carries no real "completed" semantics — swap the green
  // status check for the brain glyph so the node reads as a reasoning step
  // (grouping guarantees a thinking section holds only thinking steps).
  const isThinking = section.steps[0]?.kind === "thinking";

  return (
    <div
      data-testid="phase-section"
      data-phase-label={section.label}
      className="relative flex flex-col gap-2"
    >
      {!isLast && <TimelineConnector />}
      {/* Header row: circular node + label share ONE items-center row so the
          icon is vertically centered with the title regardless of line-height;
          the duration is pushed to the right edge. */}
      <div
        data-testid="phase-header"
        className="flex items-center justify-between gap-2 py-[2px]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <TimelineNode status={status} isThinking={isThinking} />
          <Typography
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {section.label}
          </Typography>
        </span>
        {totalDuration ? (
          <PhaseDurationLabel
            durationLabel={totalDuration}
            startedAt={phaseStartedAt(section.steps)}
          />
        ) : null}
      </div>
      {/* Steps aligned under the phase title (icon 14px + the row's 8px gap →
          22px). The whole timeline body is already indented under the card
          header by its container, so the pills only need to align with their
          own phase title here. Non-last sections add `pb-3` so the connector
          line runs unbroken down to the next circle. */}
      <div
        className={cn(
          "flex min-w-0 flex-col items-start gap-1 pl-[22px]",
          !isLast && "pb-3",
        )}
      >
        {renderSectionSteps(section, baseIndex)}
      </div>
    </div>
  );
}

/**
 * The vertical connector line joining one timeline node down to the next. Sits
 * at the node's center x (`left-[6.5px]`: the 14px icon at the section's left →
 * center ≈ 7px). It starts BELOW this node (`top-6`) and runs to the section
 * bottom (`bottom-0`), landing a small, consistent gap before the next node —
 * the timeline reads as evenly-spaced segments rather than one line touching
 * every circle. Render only for non-last sections (nothing trails below the
 * final circle). Shared by the main-chat timeline and the subagent timeline so
 * the geometry stays in one place; callers may pass `className` to tweak it
 * (e.g. the subagent timeline extends the bottom for a tighter segment gap).
 */
export function TimelineConnector({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute bottom-0 left-[6.5px] top-6 w-px bg-[var(--border-subtle)]",
        className,
      )}
    />
  );
}

/**
 * A timeline status node — the circular status icon. The connector lines start
 * below / end above each node (with a small gap), so the icon never needs to
 * mask the line passing behind it.
 */
export function TimelineNode({
  status,
  isThinking,
}: {
  status: PhaseHeaderStatus;
  isThinking: boolean;
}) {
  if (isThinking) {
    return (
      <Brain
        aria-hidden="true"
        data-testid="phase-header-status-icon"
        data-status="thinking"
        className="h-[14px] w-[14px] shrink-0 text-[var(--content-secondary)]"
      />
    );
  }
  return <TimelineNodeIcon status={status} testId="phase-header-status-icon" />;
}

/**
 * Circular status node for the vertical timeline. Mirrors the card header's
 * iconography for visual harmony — a green `CheckCircle2` when the phase
 * settled and the animated `ThreeDotIndicator` while running. Keeps the
 * `data-testid` / `data-status` attributes the flat `PhaseHeaderRow` stamps
 * so existing status-icon assertions resolve against either layout.
 */
function TimelineNodeIcon({
  status,
  testId,
}: {
  status: PhaseHeaderStatus;
  testId: string;
}) {
  if (status === "completed") {
    return (
      <CheckCircle2
        aria-hidden="true"
        data-testid={testId}
        data-status="completed"
        className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
      />
    );
  }
  return <ThreeDotIndicator data-testid={testId} className="shrink-0" />;
}

/**
 * Stable per-step key — a tool step's non-empty `toolCallId`, else the
 * positional `${kind}-${idx}` fallback. Historical/older subagent events can
 * carry an empty `toolCallId` (see `use-subagent-card-data.ts`), so guarding on
 * a non-empty string keeps keys unique instead of collapsing every empty-id
 * tool step onto the same `""` key. Shared with the subagent phase timeline.
 */
export function stepKey(step: ToolCallCardStep, idx: number): string {
  if (step.kind === "tool" && step.toolCallId) return step.toolCallId;
  return `${step.kind}-${idx}`;
}

function PhaseHeaderRow({
  label,
  durationLabel,
  status,
}: {
  label: string;
  durationLabel: string;
  status: PhaseHeaderStatus;
}) {
  return (
    <div
      data-testid="phase-header"
      className="flex items-center justify-between py-[2px]"
    >
      <div className="flex items-center gap-1">
        {status === "completed" ? (
          <Check
            aria-hidden="true"
            data-testid="phase-header-status-icon"
            data-status="completed"
            className="h-[14px] w-[14px] text-[var(--system-positive-strong)]"
          />
        ) : (
          <ThreeDotIndicator
            data-testid="phase-header-status-icon"
            // `shrink-0` with no fixed width: the dots keep their natural 8px
            // footprint (matching the card header) and own their full width in
            // the flex row, so the row's `gap-1` always separates them from the
            // label. A fixed `w-[14px]` here let the wider dots overflow onto
            // the label — flex overflow ignores the gap — which is the overlap
            // this replaces.
            className="shrink-0"
          />
        )}
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-default)]"
        >
          {label}
        </Typography>
      </div>
      {durationLabel ? (
        <Typography
          variant="label-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          {durationLabel}
        </Typography>
      ) : null}
    </div>
  );
}

/**
 * Whether {@link DefaultStepPill} renders a non-null body for a step — the
 * single source of truth for "does this step produce a pill". Consumers that
 * gate UI on whether a step is worth revealing (e.g. row expandability in the
 * subagent timeline) call this so they can never drift from the rendering:
 *
 *  - `thinking` → always renders a pill.
 *  - `tool` → renders only when `info` is non-empty (status is ignored: a
 *    failing tool step with no `info` still has nothing to show).
 *  - `tool_error` / `web_search_error` → always render a message.
 *  - `web_search` → always renders its title.
 */
export function stepRendersPill(step: ToolCallCardStep): boolean {
  switch (step.kind) {
    case "thinking":
      return true;
    case "tool":
      return step.info.length > 0;
    case "tool_error":
    case "web_search_error":
    case "web_search":
      return true;
  }
}

/**
 * Default per-step pill rendering — a single bordered pill containing the
 * step's icon (when available) and its primary text. Matches Figma
 * `5010-103135` — 100px radius, 10px/6px padding, `--surface-base` border.
 *
 * Exported so consumers that need to interleave extra UI (e.g. the
 * unified card's "Create a rule" nudge under a step) can render the
 * default pill alongside their own children inside a `renderStep`
 * override.
 */
export function DefaultStepPill({ step }: { step: ToolCallCardStep }) {
  if (step.kind === "thinking") {
    return (
      <StepPill>
        <PillText>{step.text}</PillText>
      </StepPill>
    );
  }
  if (step.kind === "tool") {
    const Glyph = ICON_MAP[step.iconName] ?? Bolt;
    // `info` is the canonical per-tool detail (file basename, bash command,
    // skill name, etc). When the labeler couldn't extract one, suppress the
    // pill entirely rather than duplicating the phase header's title — e.g.
    // a skill call with no skill name shouldn't render a literal "Using a
    // skill" pill underneath a "Using a skill" phase header.
    if (!stepRendersPill(step)) return null;
    return (
      <StepPill>
        <Glyph
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-[var(--content-secondary)]"
        />
        <PillText>{step.info}</PillText>
      </StepPill>
    );
  }
  if (step.kind === "tool_error") {
    return (
      <StepPill>
        <PillText>{step.message}</PillText>
      </StepPill>
    );
  }
  if (step.kind === "web_search_error") {
    return (
      <StepPill>
        <PillText>{step.errorMessage}</PillText>
      </StepPill>
    );
  }
  // step.kind === "web_search" — default rendering just shows the title;
  // consumers that need favicons supply a `renderStep` override.
  return (
    <StepPill>
      <PillText>{step.title}</PillText>
    </StepPill>
  );
}

/**
 * Wrap a string in a Typography element configured to truncate when its
 * surrounding pill is narrower than the text. The truncate utility requires
 * `display: block | inline-block` to fire, so the Typography variant here
 * stays default-display rather than inline-flex (which a previous version
 * tried, suppressing ellipsis entirely).
 */
function PillText({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="body-small-default"
      className="min-w-0 truncate text-inherit"
    >
      {children}
    </Typography>
  );
}

function StepPill({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="phase-step-pill"
      className="inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border border-[var(--border-element)] bg-transparent px-2 py-1 text-[var(--content-default)]"
    >
      {children}
    </div>
  );
}
