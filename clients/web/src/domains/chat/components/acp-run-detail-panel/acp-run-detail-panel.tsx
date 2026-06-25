/**
 * Side-drawer detail panel for an ACP run. Mirrors `SubagentDetailPanel`:
 * header (agent title + status badge + optional Stop + Close), a token-metric
 * row, a collapsible objective, and a step timeline — plus a single-level nested
 * detail per step (the same pattern the subagent panel uses).
 *
 * Nested detail bodies by step kind:
 *   - `tool:*`   → reuses `ToolDetailBody`; output streams live from the acp-run
 *                  store via `useLiveAcpToolOutput` while the tool is running.
 *   - `msg:*`    → accumulated markdown (live while `isComplete === false`).
 *   - `thought:*`→ accumulated markdown.
 *   - `plan`     → a checklist of `{ label, checked }` entries.
 */

import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  ListChecks,
  MessageSquare,
  RotateCw,
  Send,
  Square,
  X,
} from "lucide-react";

import {
  useCallback,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import {
  AnimatedMetricCard,
  formatNumber,
} from "@/domains/chat/components/metric-card";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";
import { ToolDetailBody } from "@/domains/chat/components/tool-detail-panel";
import { AcpRunPhaseTimeline } from "@/domains/chat/components/acp-run-detail-panel/acp-run-phase-timeline";
import {
  useAcpRunSteps,
  type AcpTimelineStep,
} from "@/domains/chat/acp-run-step-projection";
import { useAcpRunStore, type AcpRunEntry } from "@/domains/chat/acp-run-store";
import {
  steerAcpRun,
  stopAcpRun,
} from "@/domains/chat/utils/acp-run-actions";
import {
  acpRunStatusColor,
  acpRunStatusLabel,
  isActiveAcpStatus,
} from "@/utils/acp-run-status";
import { captureError } from "@/lib/sentry/capture-error";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Live joined output for a running ACP tool, re-derived from the store so an
 * open detail streams as `tool_call_update` events land. Re-projects the run's
 * events to find the matching tool step and joins its `outputChunks`. Returns
 * `undefined` when the tool can't be resolved, so the caller falls back to the
 * open-time snapshot. The ACP sibling of `useLiveToolCall`.
 */
export function useLiveAcpToolOutput(
  acpSessionId: string,
  toolCallId: string,
): string | undefined {
  const events = useAcpRunStore((s) => s.byId[acpSessionId]?.events);
  return useMemo(() => {
    if (!events) return undefined;
    let output: string | undefined;
    for (const ev of events) {
      // ACP carries the full output snapshot on each event, not a delta — hold
      // the latest. `tool_call` may seed it; `tool_call_update`s replace it.
      const matches =
        (ev.updateType === "tool_call" ||
          ev.updateType === "tool_call_update") &&
        ev.toolCallId === toolCallId;
      if (matches && ev.content !== undefined) output = ev.content;
    }
    return output;
  }, [events, toolCallId]);
}

/**
 * Leading header glyph: the active nested step's kind icon, or `Code` for the
 * top-level run timeline (its agent header).
 */
function HeaderGlyph({
  step,
  className,
}: {
  step: AcpTimelineStep | undefined;
  className: string;
}) {
  switch (step?.kind) {
    case "message":
      return <MessageSquare aria-hidden className={className} />;
    case "thought":
      return <Brain aria-hidden className={className} />;
    case "plan":
      return <ListChecks aria-hidden className={className} />;
    default:
      return <Code aria-hidden className={className} />;
  }
}

/** The breadcrumb tail / nested-detail header title for a step. */
function stepTitle(step: AcpTimelineStep): string {
  switch (step.kind) {
    case "tool":
      return step.title || step.toolKind || "Tool call";
    case "message":
      return "Response";
    case "thought":
      return "Thinking";
    case "plan":
      return "Plan";
  }
}

/** Renders a plan step as a static checklist. */
function PlanDetailBody({
  step,
}: {
  step: Extract<AcpTimelineStep, { kind: "plan" }>;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {step.entries.map((entry, index) => (
        <li key={`${index}-${entry.label}`} className="flex items-start gap-2">
          <span
            aria-hidden
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border ${
              entry.checked
                ? "border-[var(--system-positive-strong)] bg-[var(--system-positive-strong)]"
                : "border-[var(--border-base)]"
            }`}
          >
            {entry.checked && (
              <Check className="h-3 w-3 text-[var(--surface-base)]" />
            )}
          </span>
          <Typography
            variant="body-medium-default"
            as="span"
            className={
              entry.checked
                ? "text-[var(--content-tertiary)] line-through"
                : "text-[var(--content-default)]"
            }
          >
            {entry.label}
          </Typography>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tool-step nested body. Reuses `ToolDetailBody` by building a `ToolDetailPayload`
 * from the captured step (its title/kind) with the live joined output as the
 * result/streamed output. A running tool streams via `useLiveAcpToolOutput`.
 */
function AcpToolDetailBody({
  acpSessionId,
  step,
}: {
  acpSessionId: string;
  step: Extract<AcpTimelineStep, { kind: "tool" }>;
}) {
  const liveOutput = useLiveAcpToolOutput(acpSessionId, step.toolCallId);
  const output = liveOutput ?? step.outputChunks.join("");
  const isRunning = step.status === "running";

  const detail: ToolDetailPayload = {
    toolCallId: step.toolCallId,
    toolName: step.toolKind ?? step.title,
    title: step.title,
    activity: "",
    input: {},
    // A settled tool surfaces its output as the final result; a running tool
    // surfaces the same joined output as the live streamed tail.
    result: isRunning ? undefined : output || undefined,
    streamedOutput: output || undefined,
    status: step.status,
  };

  return <ToolDetailBody detail={detail} showTechnicalDetailsLabel={false} />;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AcpRunDetailPanelProps {
  entry: AcpRunEntry;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AcpRunDetailPanel({
  entry,
  onClose,
}: AcpRunDetailPanelProps) {
  const isRunning = isActiveAcpStatus(entry.status);
  const steps = useAcpRunSteps(entry.events);

  // Which step's nested detail is shown (its array index in `steps`), or `null`
  // for the timeline. Index — not `detailKey` — because anonymous message/thought
  // steps (no `messageId`) share a `detailKey`, so a key-based lookup would
  // collide. Reset on run switch via the render-phase block below.
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(
    null,
  );

  // Objective collapse/expand. The "Show more" affordance is gated on the
  // clamp's static line count via the projected step text length, not a layout
  // measurement (happy-dom has no layout) — kept simple: always show the toggle
  // for a multi-line task.
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);

  // Stop disables after a click to avoid a double-cancel; steering tracks the
  // input value and a transient "awaiting approval" affordance.
  const [stopping, setStopping] = useState(false);
  const [steerInput, setSteerInput] = useState("");
  const [steerPending, setSteerPending] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);

  // Reset nested + action state on run switch — render-phase guard tracking the
  // prev id.
  const [prevSessionId, setPrevSessionId] = useState(entry.acpSessionId);
  if (prevSessionId !== entry.acpSessionId) {
    setPrevSessionId(entry.acpSessionId);
    setSelectedStepIndex(null);
    setObjectiveExpanded(false);
    setStopping(false);
    setSteerInput("");
    setSteerPending(false);
    setApprovalPending(false);
  }

  const handleStepDetailClick = useCallback(
    (index: number) => setSelectedStepIndex(index),
    [],
  );
  const handleBack = useCallback(() => setSelectedStepIndex(null), []);

  const handleStop = useCallback(() => {
    setStopping(true);
    void stopAcpRun(entry.acpSessionId).catch((err) => {
      setStopping(false);
      captureError(err, { context: "AcpRunDetailPanel.stop" });
    });
  }, [entry.acpSessionId]);

  const handleSteerSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const instruction = steerInput.trim();
      if (!instruction || steerPending) return;
      setSteerPending(true);
      setApprovalPending(false);

      // Optimistic timeline marker so the steer is visible immediately, ahead
      // of the daemon's echoed events. Seq sits above the run's high-water mark
      // so it sorts last and never collides with a replayed event.
      const store = useAcpRunStore.getState();
      const seq = (store.highWaterMark.get(entry.acpSessionId) ?? 0) + 1;
      store.receiveEvent({
        acpSessionId: entry.acpSessionId,
        event: {
          seq,
          updateType: "agent_message_chunk",
          messageId: `steer-${seq}`,
          content: `↻ Steering: ${instruction}`,
        },
      });

      void steerAcpRun(entry.acpSessionId, instruction)
        .then((res) => {
          setSteerInput("");
          setApprovalPending(res.approvalPending === true);
        })
        .catch((err) => {
          captureError(err, { context: "AcpRunDetailPanel.steer" });
        })
        .finally(() => setSteerPending(false));
    },
    [steerInput, steerPending, entry.acpSessionId],
  );

  // Resolve by index; fall back to the timeline if the steps array shrank past
  // the selected index (e.g. history hydration replaced the buffer).
  const activeStep =
    selectedStepIndex !== null ? steps[selectedStepIndex] : undefined;

  const detailTitle = activeStep ? stepTitle(activeStep) : "";
  const headerTitle = activeStep ? detailTitle : entry.agent;

  // A long task offers the collapse toggle. Heuristic on length so happy-dom
  // (no layout) can exercise it deterministically.
  const objectiveOverflows = (entry.task?.length ?? 0) > 140;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Breadcrumb — only while a nested step detail is open. */}
      {activeStep && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
          <button
            type="button"
            onClick={handleBack}
            title={entry.agent}
            className="min-w-0 shrink cursor-pointer truncate text-left text-[var(--content-default)] hover:underline"
          >
            <Typography variant="body-small-default" as="span">
              {entry.agent}
            </Typography>
          </button>
          <ChevronRight
            className="h-2.5 w-2.5 shrink-0 text-[var(--content-tertiary)]"
            aria-hidden
          />
          <Typography
            variant="body-small-default"
            as="span"
            title={detailTitle}
            className="min-w-0 shrink truncate text-[var(--content-secondary)]"
          >
            {detailTitle}
          </Typography>
        </div>
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        {activeStep && (
          <Button
            variant="outlined"
            iconOnly={<ArrowLeft />}
            onClick={handleBack}
            aria-label="Back to timeline"
            tooltip="Back"
            className="shrink-0 rounded-lg"
          />
        )}
        <HeaderGlyph
          step={activeStep}
          className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
        />
        <Typography
          variant="title-medium"
          title={headerTitle}
          className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
        >
          {headerTitle}
        </Typography>
        {!activeStep && (
          <StatusBadgePill
            color={acpRunStatusColor(entry.status)}
            label={acpRunStatusLabel(entry.status)}
          />
        )}
        <span className="flex-1" />
        {isRunning && !activeStep && (
          <button
            type="button"
            aria-label="Stop run"
            onClick={handleStop}
            disabled={stopping}
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)] bg-transparent px-2.5 py-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-default disabled:opacity-50"
          >
            <Square className="h-3 w-3" fill="currentColor" />
            <Typography variant="label-small-default">Stop</Typography>
          </button>
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close run detail"
          tooltip="Close"
          className="shrink-0 rounded-lg"
        />
      </div>

      {/* Scrollable body — swaps to a step's nested detail when one is selected. */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {activeStep ? (
          activeStep.kind === "tool" ? (
            <AcpToolDetailBody
              acpSessionId={entry.acpSessionId}
              step={activeStep}
            />
          ) : activeStep.kind === "plan" ? (
            <PlanDetailBody step={activeStep} />
          ) : (
            <ChatMarkdownMessage content={activeStep.content} hardLineBreaks />
          )
        ) : (
          <>
            {/* Error — a failed run surfaces its message under the status badge. */}
            {entry.status === "failed" && entry.error && (
              <div className="mb-5 rounded-lg border border-[var(--system-negative-strong)] bg-[var(--system-negative-weak)] px-3 py-2.5">
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="whitespace-pre-wrap break-words text-[var(--system-negative-strong)]"
                >
                  {entry.error}
                </Typography>
              </div>
            )}

            {/* Metrics row — gated on real usage so a run with no token/cost
                data doesn't show a misleading all-zero meter. */}
            {(entry.inputTokens > 0 ||
              entry.outputTokens > 0 ||
              entry.totalCost > 0) && (
              <div className="mb-5 grid grid-cols-2 gap-3">
                <AnimatedMetricCard
                  icon={
                    <ArrowDownToLine
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  }
                  target={entry.inputTokens}
                  format={(n) => formatNumber(Math.round(n))}
                  label="Input"
                />
                <AnimatedMetricCard
                  icon={
                    <ArrowUpFromLine
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  }
                  target={entry.outputTokens}
                  format={(n) => formatNumber(Math.round(n))}
                  label="Output"
                />
              </div>
            )}

            {/* Objective section */}
            {entry.task && (
              <div className="mb-5">
                <Typography
                  variant="body-medium-default"
                  as="h3"
                  className="mb-2 text-[var(--content-emphasised)]"
                >
                  Objective
                </Typography>
                <Typography
                  variant="body-medium-lighter"
                  as="p"
                  className={`whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)] ${
                    objectiveExpanded ? "" : "line-clamp-5"
                  }`}
                >
                  {entry.task}
                </Typography>
                {objectiveOverflows && (
                  <button
                    type="button"
                    onClick={() => setObjectiveExpanded((prev) => !prev)}
                    className="mt-1.5 flex cursor-pointer items-center gap-1 text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
                  >
                    <Typography variant="label-small-default">
                      {objectiveExpanded ? "Show less" : "Show more"}
                    </Typography>
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${
                        objectiveExpanded ? "rotate-180" : ""
                      }`}
                      aria-hidden
                    />
                  </button>
                )}
                <div className="mt-5 h-px w-full bg-[var(--border-hover)]" />
              </div>
            )}

            {/* Timeline section */}
            <div>
              <Typography
                variant="title-medium"
                as="h3"
                className="mb-4 text-[var(--content-emphasised)]"
              >
                Timeline
              </Typography>
              {steps.length > 0 ? (
                <AcpRunPhaseTimeline
                  steps={steps}
                  isRunActive={isRunning}
                  onStepDetailClick={handleStepDetailClick}
                />
              ) : (
                <Typography
                  variant="body-small-default"
                  className="py-4 text-center text-[var(--content-tertiary)]"
                >
                  No events yet
                </Typography>
              )}
            </div>
          </>
        )}
      </div>

      {/* Steering — send a follow-up instruction while the run is live. */}
      {entry.status === "running" && !activeStep && (
        <form
          onSubmit={handleSteerSubmit}
          className="shrink-0 border-t border-[var(--border-hover)] px-5 py-3"
        >
          {approvalPending && (
            <Typography
              variant="body-small-default"
              as="p"
              className="mb-2 flex items-center gap-1.5 text-[var(--content-secondary)]"
            >
              <RotateCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Awaiting approval to resume…
            </Typography>
          )}
          <div className="flex items-center gap-2 rounded-md bg-[var(--surface-base)] px-3 py-2">
            <input
              type="text"
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              placeholder="Steer the run…"
              disabled={steerPending}
              aria-label="Steering instruction"
              className="text-body-medium-default min-w-0 flex-1 bg-transparent text-[color:var(--content-default)] placeholder:text-[color:var(--content-tertiary)] focus:outline-none disabled:opacity-50"
            />
            <Button
              type="submit"
              variant="primary"
              size="compact"
              iconOnly={<Send />}
              disabled={steerPending || steerInput.trim() === ""}
              aria-label="Send steering instruction"
              className="shrink-0"
            />
          </div>
        </form>
      )}
    </div>
  );
}
