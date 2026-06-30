/**
 * Background-process descriptor for the **workflow** kind.
 *
 * Workflow is the lone count-variant surface: its overlay pill renders a single
 * static {@link Workflow} glyph next to the active count, not a stack of
 * per-process chips. The inline card's count slot is a custom
 * {@link WorkflowAgentsChip} (avatar stack + "N agents") via `renderCount`.
 */

import { Workflow } from "lucide-react";

import { useActiveWorkflowRunIds } from "@/domains/chat/hooks/use-active-workflow-run-ids";
import { useWorkflowCardData } from "@/domains/chat/hooks/use-workflow-card-data";
import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";
import { WorkflowAgentsChip } from "@/domains/chat/process-registry/descriptors/workflow-agents-chip";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Projects a single run's {@link useWorkflowCardData} into the shared
 * {@link CardSummary} shape. The card data's `stepCount` is already a
 * pre-formatted noun string (e.g. `"3 agents"`), so it maps directly to
 * `count`. Passes `null` through when the run has no card-worthy state yet.
 */
function useWorkflowCardSummary(id: string): CardSummary | null {
  const data = useWorkflowCardData(id);
  if (!data) return null;
  return {
    state: data.state,
    title: data.currentStepTitle,
    info: data.currentStepInfo,
    count: data.stepCount,
  };
}

export const WORKFLOW_DESCRIPTOR: BackgroundProcessDescriptor = {
  kind: "workflow",
  useActiveIds: useActiveWorkflowRunIds,
  useCardSummary: useWorkflowCardSummary,
  renderCardLeading: () => (
    <Workflow className="h-4 w-4 text-[var(--content-secondary)]" aria-hidden />
  ),
  pill: {
    variant: "count",
    glyph: (
      <Workflow
        className="h-4 w-4 shrink-0 text-[var(--content-secondary)]"
        aria-hidden
      />
    ),
  },
  overlayTitle: (n) => `${n} Active Workflow${n === 1 ? "" : "s"}`,
  pillAriaLabel: (n) => `${n} active workflow${n === 1 ? "" : "s"}`,
  openCardAriaLabel: "Open workflow",
  onOpenDetail: (id) =>
    useViewerStore.getState().openProcessDetail({ kind: "workflow", id }),
  onStop: (id) => void useWorkflowStore.getState().abortRun(id),
  renderCount: (id) => <WorkflowAgentsChip runId={id} />,
};
