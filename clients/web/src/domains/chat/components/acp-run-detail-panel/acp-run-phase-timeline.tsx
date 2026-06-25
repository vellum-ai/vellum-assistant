/**
 * Vertical list of clickable step pills for the ACP run detail panel.
 *
 * ACP steps are a flat, ordered `AcpTimelineStep[]` (not phase-grouped like the
 * subagent timeline), so this renders one `AcpRunStepPill` per step. Selection
 * is lifted to the owning panel via `onStepDetailClick(index)` — by array index,
 * since anonymous steps share a `detailKey` — mirroring how `SubagentPhaseTimeline`
 * lifts its expand/selection state.
 *
 * Pure / presentational: takes only `steps`. The owning panel renders the empty
 * state, so this returns `null` for an empty input.
 */

import type { AcpTimelineStep } from "@/domains/chat/acp-run-step-projection";
import { AcpRunStepPill } from "@/domains/chat/components/acp-run-detail-panel/acp-run-step-pill";

/** Stable key for a step — its detail key plus its positional index. */
function stepKey(step: AcpTimelineStep, index: number): string {
  return `${index}-${step.detailKey}`;
}

export function AcpRunPhaseTimeline({
  steps,
  isRunActive,
  onStepDetailClick,
}: {
  steps: AcpTimelineStep[];
  /** Whether the owning run is still active (drives trailing-message liveness). */
  isRunActive: boolean;
  /** Opens a step's nested detail, identified by its array index. */
  onStepDetailClick: (index: number) => void;
}) {
  if (steps.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {steps.map((step, index) => (
        <AcpRunStepPill
          key={stepKey(step, index)}
          step={step}
          index={index}
          isRunActive={isRunActive}
          onClick={onStepDetailClick}
        />
      ))}
    </div>
  );
}
