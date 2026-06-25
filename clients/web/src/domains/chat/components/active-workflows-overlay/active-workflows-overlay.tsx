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
      // Content-width + relative so the pill can sit adjacent to a sibling overlay
      // pill; none here so gutter clicks reach the transcript, pill + panel re-enable.
      className="pointer-events-none relative flex w-auto flex-col items-center"
    >
      <ActiveWorkflowsPill
        count={workflowRunIds.length}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />

      {expanded && (
        // Absolute dropdown anchored under the pill so its 589px width no longer
        // dictates the row's width (Figma 6063:149685).
        <div className="pointer-events-auto absolute left-1/2 top-full z-20 mt-2 flex w-[min(589px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-4 rounded-xl bg-[var(--surface-lift)] px-3 py-4 shadow-lg">
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
