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
  AlertTriangle,
  Bolt,
  Check,
  Code,
  FileText,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Typography } from "@vellum/design-library";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import type { ToolCallCardStep } from "@/domains/chat/hooks/use-tool-call-card-data";
import { formatMs } from "@/domains/chat/hooks/use-tool-call-card-data";
import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";

/** Concrete lucide icon for each `IconName` produced by `deriveStepLabel`. */
const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  file: FileText,
  pen: Pen,
  monitor: Monitor,
  plug: Plug,
  sparkle: Sparkles,
  "user-plus": UserPlus,
  bolt: Bolt,
};

/**
 * Derive the human-readable phase label for a step. Contiguous steps that
 * share the same label collapse into a single `PhaseSection`.
 *
 * `tool` branch:
 *   - "Working (bash)" → kept verbatim so bash sections read distinctly
 *   - Other "Working (...)" titles → kept verbatim
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
 * value so we can sum phase totals. Handles the two outputs the formatter
 * produces today (`"<1s"`, `"Ns"`) plus an empty / missing label.
 */
function parseDurationLabel(label: string): number {
  if (!label) return 0;
  if (label === "<1s") return 0;
  const match = /^(\d+)s$/.exec(label);
  if (!match) return 0;
  return Number(match[1]) * 1000;
}

/** Total of `formatMs`-style labels, re-formatted via `formatMs`. */
function sumDurationLabels(labels: string[]): string {
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

/**
 * Header status states a phase can render. "Running" wins over "failed" so
 * an in-flight retry inside a phase that has already produced a failure
 * still reads as in-progress.
 */
type PhaseHeaderStatus = "completed" | "failed" | "running";

/**
 * Classify a phase's overall status for header icon rendering.
 *
 * Precedence: any running step → "running"; otherwise any failure
 * (`tool_error` / `web_search_error` / `tool` status `error`|`denied`) →
 * "failed"; otherwise → "completed".
 *
 * `web_search` steps carry no explicit status field — `useToolCallCardData`
 * encodes "in-flight" via the present-tense title ("Searching the web" vs
 * "Searched the web"), so we treat any `web_search` step with that title
 * as in-flight. `thinking` is always neutral (no in-flight signal carried).
 */
function phaseHeaderStatus(steps: ToolCallCardStep[]): PhaseHeaderStatus {
  if (steps.length === 0) return "running";
  let failed = false;
  for (const step of steps) {
    if (step.kind === "tool") {
      if (step.status === "running") return "running";
      if (step.status === "error" || step.status === "denied") failed = true;
      continue;
    }
    if (step.kind === "web_search") {
      // Title is the canonical in-flight signal — see `webSearchStepTitle`
      // in `use-tool-call-card-data.ts`.
      if (step.title === "Searching the web") return "running";
      continue;
    }
    if (step.kind === "tool_error" || step.kind === "web_search_error") {
      failed = true;
    }
    // `thinking` is neutral — see docstring.
  }
  return failed ? "failed" : "completed";
}

/** Phase-grouped section as consumed by the renderer. */
interface PhaseSection {
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
}

export function PhaseGroupedStepList({
  steps,
  renderStep,
}: PhaseGroupedStepListProps) {
  if (steps.length === 0) return null;
  const sections = groupStepsByPhase(steps);
  let globalIndex = 0;
  return (
    <div className="flex w-full flex-col gap-3">
      {sections.map((section, sectionIdx) => {
        const totalDuration = sumDurationLabels(
          section.steps.map((s) =>
            "durationLabel" in s ? s.durationLabel : "",
          ),
        );
        const status = phaseHeaderStatus(section.steps);
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
            <div className="flex min-w-0 flex-wrap items-start gap-1 pl-[24px]">
              {section.steps.map((step) => {
                const key = stepKey(step, globalIndex);
                globalIndex += 1;
                return (
                  <Fragment key={key}>
                    {renderStep ? renderStep(step) : <DefaultStepPill step={step} />}
                  </Fragment>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Stable key for a step descriptor — mirrors the dispatcher card helper. */
function stepKey(step: ToolCallCardStep, idx: number): string {
  if (step.kind === "tool") return step.toolCallId;
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
            className="h-[14px] w-[14px] text-[#277E41]"
          />
        ) : status === "failed" ? (
          <AlertTriangle
            aria-hidden="true"
            data-testid="phase-header-status-icon"
            data-status="failed"
            className="h-[14px] w-[14px] text-[var(--system-negative-strong)]"
          />
        ) : (
          <ThreeDotIndicator
            data-testid="phase-header-status-icon"
            className="h-[14px] w-[14px]"
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
    if (!step.info) return null;
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
      <StepPill tone="error">
        <PillText>{step.message}</PillText>
      </StepPill>
    );
  }
  if (step.kind === "web_search_error") {
    return (
      <StepPill tone="error">
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

function StepPill({
  tone = "default",
  children,
}: {
  tone?: "default" | "error";
  children: ReactNode;
}) {
  const toneClasses =
    tone === "error"
      ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
      : "border-[var(--surface-base)] bg-transparent text-[var(--content-default)]";
  return (
    <div
      data-testid="phase-step-pill"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border px-[10px] py-[6px] ${toneClasses}`}
    >
      {children}
    </div>
  );
}
