/**
 * Inline workflow progress card rendered per-`run_workflow` run in the
 * assistant transcript. Built on `ToolProgressCardShell` with a workflow
 * glyph slotted into the leading-icon slot — workflows have no avatar.
 *
 * Subscribes to the workflow store via `useWorkflowCardData(runId)`.
 * Returns `null` when the entry isn't in the store yet — handles the
 * spawn race where the assistant message containing the inline card
 * mounts a hair before the `workflow_started` SSE event lands. A later
 * PR wires this into the transcript; this PR ships the component
 * standalone.
 *
 * Interaction model mirrors the subagent inline card:
 *   - Clicking anywhere on the header row opens the workflow's detail
 *     panel via `onWorkflowClick`. There is no inline expand — the panel
 *     is the only detail view.
 *   - Stop is exposed via `onStopWorkflow`; the shell renders a small
 *     stop chip in the right rail while the run is in-flight.
 */

import { Square, Workflow } from "lucide-react";
import { useCallback, type MouseEvent } from "react";

import { Button } from "@vellumai/design-library";

import { PhaseGroupedStepList } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { useWorkflowCardData } from "@/domains/chat/hooks/use-workflow-card-data";

export interface WorkflowInlineProgressCardProps {
  runId: string;
  /**
   * Invoked when the user activates the header row. Routes to the
   * workflow detail panel.
   */
  onWorkflowClick?: (runId: string) => void;
  /**
   * Invoked when the user activates the stop button while the run is
   * in-flight. Omitted callers hide the button entirely.
   */
  onStopWorkflow?: (runId: string) => void;
}

export function WorkflowInlineProgressCard({
  runId,
  onWorkflowClick,
  onStopWorkflow,
}: WorkflowInlineProgressCardProps) {
  const data = useWorkflowCardData(runId);
  // The shell's `loading` state is the live window where stopping the
  // workflow is a meaningful action (see `deriveCardState`).
  const isRunning = data?.state === "loading";

  const handleHeaderClick = useCallback(() => {
    onWorkflowClick?.(runId);
  }, [onWorkflowClick, runId]);

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onStopWorkflow?.(runId);
    },
    [onStopWorkflow, runId],
  );

  // Spawn-race: assistant message references a run before the
  // `workflow_started` event lands. Render `null` rather than a blank
  // shell so the transcript doesn't flicker an empty card.
  if (!data) return null;

  const leadingIcon = <Workflow size={20} aria-hidden />;

  const actionSlot =
    onStopWorkflow && isRunning ? (
      <Button
        variant="dangerGhost"
        size="compact"
        iconOnly={<Square fill="currentColor" />}
        aria-label="Stop workflow"
        data-testid="workflow-inline-card-stop"
        onClick={handleStop}
      />
    ) : undefined;

  return (
    <div className="w-full" data-testid="workflow-inline-progress-card">
      <ToolProgressCardShell
        data-testid="workflow-inline-card-shell"
        statusIndicatorTestId="workflow-inline-card-status-indicator"
        state={data.state}
        leadingIcon={leadingIcon}
        currentStepTitle={data.currentStepTitle}
        currentStepInfo={data.currentStepInfo}
        stepCount={data.stepCount}
        // No inline timeline to reveal — the detail panel is the only
        // detail view, so the expanded body stays disabled.
        disableExpand
        headerActionSlot={actionSlot}
        onHeaderClick={onWorkflowClick ? handleHeaderClick : undefined}
        headerAriaLabel={onWorkflowClick ? "Open workflow" : undefined}
      >
        {/* Children unused — `disableExpand` suppresses the body region. */}
        <div className="hidden">
          <PhaseGroupedStepList steps={data.steps} />
        </div>
      </ToolProgressCardShell>
    </div>
  );
}
