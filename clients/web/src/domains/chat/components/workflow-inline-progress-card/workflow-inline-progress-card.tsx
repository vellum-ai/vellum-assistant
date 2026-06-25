// Inline per-`run_workflow` progress row, rendered in the transcript and in the
// active-workflows overlay dropdown. Mirrors the subagent inline card
// (`SubagentInlineProgressCard`, Figma 6063:148642) exactly so the two read as
// one language: status indicator → workflow glyph → Name | detail carousel →
// "X agents" → stop, on the transparent chat background with a full-row
// --surface-active hover (no boxed surface). The leading cluster is the open
// affordance (role="button"); the stop button stays a separate sibling so it
// isn't nested inside an interactive element.
//
// Subscribes to the workflow store via `useWorkflowCardData(runId)`. Returns
// `null` when the entry isn't in the store yet — the spawn race where the
// assistant message mounts a hair before the `workflow_started` SSE event lands.
//
// Interaction model:
//   - Clicking the leading cluster opens the workflow detail panel via
//     `onWorkflowClick`. There is no inline expand — the panel is the only
//     detail view.
//   - Stop is exposed via `onStopWorkflow` while the run is in-flight.

import { AlertCircle, CheckCircle2, Square, Workflow } from "lucide-react";
import { useCallback, type KeyboardEvent, type MouseEvent } from "react";

import { Button } from "@vellumai/design-library";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import {
  useWorkflowAgentAvatarSeeds,
  useWorkflowCardData,
} from "@/domains/chat/hooks/use-workflow-card-data";

import { WorkflowAgentsChip } from "./workflow-agents-chip";

export interface WorkflowInlineProgressCardProps {
  runId: string;
  /** Open the workflow detail panel (row activation, not the stop button). */
  onWorkflowClick?: (runId: string) => void;
  /** Stop an in-flight workflow; omit to hide the stop button. */
  onStopWorkflow?: (runId: string) => void;
}

export function WorkflowInlineProgressCard({
  runId,
  onWorkflowClick,
  onStopWorkflow,
}: WorkflowInlineProgressCardProps) {
  const data = useWorkflowCardData(runId);
  const agentSeeds = useWorkflowAgentAvatarSeeds(runId);
  // "loading" = the live window where stopping the run is meaningful
  // (see `deriveCardState`).
  const isRunning = data?.state === "loading";

  const handleOpenClick = useCallback(() => {
    onWorkflowClick?.(runId);
  }, [onWorkflowClick, runId]);

  const handleOpenKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore keydowns bubbled from children (e.g. the stop button).
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onWorkflowClick?.(runId);
      }
    },
    [onWorkflowClick, runId],
  );

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onStopWorkflow?.(runId);
    },
    [onStopWorkflow, runId],
  );

  // Spawn-race: card mounts before the `workflow_started` event lands.
  if (!data) return null;

  // Title = workflow name; detail prefers the live step info, else the title
  // (so it never reads blank or just echoes the name).
  const headerTitle = data.currentStepTitle;
  const headerInfo =
    data.currentStepInfo && data.currentStepInfo !== data.currentStepTitle
      ? data.currentStepInfo
      : data.currentStepTitle;

  // Local copy of the shared StatusIndicator chrome (matches the subagent row).
  const statusIndicator = isRunning ? (
    <ThreeDotIndicator
      className="shrink-0"
      data-testid="workflow-inline-card-status-indicator"
    />
  ) : data.state === "complete" ? (
    <CheckCircle2
      data-testid="workflow-inline-card-status-indicator"
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
    />
  ) : (
    <AlertCircle
      data-testid="workflow-inline-card-status-indicator"
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
    />
  );

  // Hidden for 0/1-agent rows where the carousel detail already says it.
  const stepCount = data.stepCount;
  const showStepCount =
    !!stepCount &&
    !stepCount.startsWith("0 ") &&
    !stepCount.startsWith("1 ");

  // Without a click handler the leading cluster is inert (not a button).
  const canOpen = !!onWorkflowClick;

  return (
    <div
      data-testid="workflow-inline-progress-card"
      className="group flex w-full items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-active)]"
    >
      <span
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-label={canOpen ? "Open workflow" : undefined}
        onClick={canOpen ? handleOpenClick : undefined}
        onKeyDown={canOpen ? handleOpenKeyDown : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1 text-left${
          canOpen ? " cursor-pointer" : ""
        }`}
      >
        {statusIndicator}
        <span className="mx-1 flex shrink-0 items-center">
          <Workflow
            className="h-4 w-4 text-[var(--content-secondary)]"
            aria-hidden
          />
        </span>
        <HeaderStepCarousel
          currentStepTitle={headerTitle}
          currentStepInfo={headerInfo}
          bypassDwell={data.state !== "loading"}
        />
      </span>
      {/* div (not span) so the chip's div root nests validly; the count text
          and Stop button stay inline via flex. Stop remains rightmost. */}
      <div className="flex shrink-0 items-center gap-2">
        {showStepCount ? (
          <WorkflowAgentsChip countLabel={stepCount} seeds={agentSeeds} />
        ) : null}
        {onStopWorkflow && isRunning ? (
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Square fill="currentColor" />}
            aria-label="Stop workflow"
            data-testid="workflow-inline-card-stop"
            onClick={handleStop}
          />
        ) : null}
      </div>
    </div>
  );
}
