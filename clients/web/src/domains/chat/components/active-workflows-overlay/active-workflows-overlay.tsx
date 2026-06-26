import { ActiveOverlayShell } from "@/domains/chat/components/active-overlay-shell";
import { ActiveWorkflowsPill } from "@/domains/chat/components/active-workflows-overlay/active-workflows-pill";
import { WorkflowInlineProgressCard } from "@/domains/chat/components/workflow-inline-progress-card/workflow-inline-progress-card";

export interface ActiveWorkflowsOverlayProps {
  workflowRunIds: string[];
  onWorkflowClick?: (runId: string) => void;
  onStopWorkflow?: (runId: string) => void;
}

export function ActiveWorkflowsOverlay({
  workflowRunIds,
  onWorkflowClick,
  onStopWorkflow,
}: ActiveWorkflowsOverlayProps) {
  if (workflowRunIds.length === 0) return null;

  return (
    <ActiveOverlayShell
      testId="active-workflows-overlay"
      title={`${workflowRunIds.length} Active Workflow${
        workflowRunIds.length === 1 ? "" : "s"
      }`}
      renderPill={({ expanded, onToggle }) => (
        <ActiveWorkflowsPill
          count={workflowRunIds.length}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
    >
      {({ close }) =>
        workflowRunIds.map((runId) => (
          <WorkflowInlineProgressCard
            key={runId}
            runId={runId}
            // Opening drills into the detail panel and dismisses the dropdown
            // so the two layers stop competing for width; stopping keeps it open.
            onWorkflowClick={
              onWorkflowClick
                ? (id) => {
                    onWorkflowClick(id);
                    close();
                  }
                : undefined
            }
            onStopWorkflow={onStopWorkflow}
          />
        ))
      }
    </ActiveOverlayShell>
  );
}
