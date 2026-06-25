import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

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
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Defensive: collapse if the active set drains while open.
  useEffect(() => {
    if (workflowRunIds.length === 0) setExpanded(false);
  }, [workflowRunIds.length]);

  // While open, dismiss on outside pointerdown or Escape.
  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

  if (workflowRunIds.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-testid="active-workflows-overlay"
      // none here so gutter clicks reach the transcript; pill + panel re-enable. 589px per Figma 6063:149685.
      className="pointer-events-none flex w-full max-w-[589px] flex-col items-center gap-2"
    >
      <ActiveWorkflowsPill
        count={workflowRunIds.length}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />

      {expanded && (
        <div className="pointer-events-auto flex w-full flex-col gap-4 rounded-xl bg-[var(--surface-lift)] px-3 py-4 shadow-lg">
          <Typography
            variant="title-small"
            className="text-[var(--content-emphasised)]"
          >
            {workflowRunIds.length} Active Workflow
            {workflowRunIds.length === 1 ? "" : "s"}
          </Typography>
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
            {workflowRunIds.map((runId) => (
              <WorkflowInlineProgressCard
                key={runId}
                runId={runId}
                onWorkflowClick={onWorkflowClick}
                onStopWorkflow={onStopWorkflow}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
