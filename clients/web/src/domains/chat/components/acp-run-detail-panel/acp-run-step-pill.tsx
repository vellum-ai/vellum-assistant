/**
 * A single clickable row in the ACP run timeline: a kind icon, a status glyph,
 * and a truncating label. Mirrors the subagent timeline's pill chrome but maps
 * the flat `AcpTimelineStep` union directly (ACP steps are not phase-grouped).
 *
 * Presentational + primitive: takes a resolved label/icon/status rather than the
 * step object, so it stays independently testable.
 */

import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Code,
  FileText,
  ListChecks,
  MessageSquare,
} from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import type {
  AcpTimelineStep,
  AcpToolStatus,
} from "@/domains/chat/acp-run-step-projection";

/** Leading kind glyph for a step row. */
function KindIcon({ step, className }: { step: AcpTimelineStep; className: string }) {
  switch (step.kind) {
    case "tool":
      // Tool kind hints (e.g. "read"/"edit") map to a document glyph; default to
      // code brackets, matching the tool-detail header's fallback.
      return step.toolKind === "read" || step.toolKind === "edit" ? (
        <FileText aria-hidden className={className} />
      ) : (
        <Code aria-hidden className={className} />
      );
    case "message":
      return <MessageSquare aria-hidden className={className} />;
    case "thought":
      return <Brain aria-hidden className={className} />;
    case "plan":
      return <ListChecks aria-hidden className={className} />;
  }
}

/** Single-line label for a step row. */
function stepLabel(step: AcpTimelineStep): string {
  switch (step.kind) {
    case "tool":
      return step.title || step.toolKind || "Tool call";
    case "message":
      return step.content || "Response";
    case "thought":
      return step.content || "Thinking";
    case "plan":
      return "Plan";
  }
}

/**
 * A step's status, used to pick the trailing status glyph. A message step shows
 * `running` only while the run is active; once the run is terminal a still-open
 * trailing message (nothing closed it) renders as complete. Tool steps keep
 * their own status regardless of run state.
 */
function stepStatus(step: AcpTimelineStep, isRunActive: boolean): AcpToolStatus {
  switch (step.kind) {
    case "tool":
      return step.status;
    case "message":
      return step.isComplete || !isRunActive ? "completed" : "running";
    case "thought":
    case "plan":
      return "completed";
  }
}

/** Trailing status glyph matching the card states (running / complete / error). */
function StatusGlyph({ status }: { status: AcpToolStatus }) {
  if (status === "running") {
    return <ThreeDotIndicator className="shrink-0" data-testid="acp-step-running" />;
  }
  if (status === "error") {
    return (
      <AlertCircle
        aria-hidden
        data-testid="acp-step-error"
        className="h-4 w-4 shrink-0 text-[var(--system-negative-strong)]"
      />
    );
  }
  return (
    <CheckCircle2
      aria-hidden
      data-testid="acp-step-complete"
      className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]"
    />
  );
}

export function AcpRunStepPill({
  step,
  index,
  isRunActive,
  onClick,
}: {
  step: AcpTimelineStep;
  /** This step's position in the run's projected steps — its selection identity. */
  index: number;
  /** Whether the owning run is still active; gates the trailing-message indicator. */
  isRunActive: boolean;
  /** Opens the step's nested detail. When omitted the row is non-interactive. */
  onClick?: (index: number) => void;
}) {
  const status = stepStatus(step, isRunActive);
  const label = stepLabel(step);
  const tone = status === "error";
  const iconColor = tone
    ? "text-[var(--system-negative-strong)]"
    : "text-[var(--content-tertiary)]";

  const body = (
    <>
      <KindIcon step={step} className={`h-4 w-4 shrink-0 ${iconColor}`} />
      <Typography
        variant="body-small-default"
        className="min-w-0 flex-1 truncate text-left text-inherit leading-normal"
      >
        {label}
      </Typography>
      <StatusGlyph status={status} />
    </>
  );

  const colorClasses = tone
    ? "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
    : "bg-[var(--surface-overlay)] text-[var(--content-default)]";

  if (onClick) {
    return (
      <button
        type="button"
        data-testid="acp-step-pill"
        aria-label={`View step details: ${label}`}
        onClick={() => onClick(index)}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--surface-active)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] ${colorClasses}`}
      >
        {body}
      </button>
    );
  }

  return (
    <span
      data-testid="acp-step-pill"
      className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 ${colorClasses}`}
    >
      {body}
    </span>
  );
}
