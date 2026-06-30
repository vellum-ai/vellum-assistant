/**
 * Background-process descriptor for the **workflow** kind.
 *
 * Workflow is the lone count-variant surface: its overlay pill renders a single
 * static {@link Workflow} glyph next to the active count (see
 * `active-workflows-pill.tsx`), not a stack of per-process chips. The card,
 * detail panel, and copy mirror the existing workflow UI exactly — this
 * descriptor is a behavior-preserving adapter onto the shared
 * {@link BackgroundProcessDescriptor} contract.
 */

import { Workflow } from "lucide-react";

import { useActiveWorkflowRunIds } from "@/domains/chat/hooks/use-active-workflow-run-ids";
import { useWorkflowCardData } from "@/domains/chat/hooks/use-workflow-card-data";
import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { WorkflowDetailPanel } from "@/domains/chat/components/workflow-detail-panel";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Adapts the `{ id; onClose }` descriptor contract onto
 * {@link WorkflowDetailPanel}, which keys on a resolved `WorkflowEntry` rather
 * than a run id. Subscribes to the workflow store entry for `id` and wires the
 * panel's stop + journal callbacks to the store the same way the existing
 * chat-content-layout host does (`abortRun` / `fetchJournalIfNeeded`). Renders
 * `null` until an entry exists, matching the host's `workflowById[id]` guard.
 */
function WorkflowDetailPanelAdapter({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const entry = useWorkflowStore((s) => s.byId[id]);
  if (!entry) return null;
  return (
    <WorkflowDetailPanel
      entry={entry}
      onClose={onClose}
      onStop={(runId) => void useWorkflowStore.getState().abortRun(runId)}
      onRequestJournal={(runId) => {
        const assistantId =
          useResolvedAssistantsStore.getState().activeAssistantId;
        if (!assistantId) return;
        void useWorkflowStore
          .getState()
          .fetchJournalIfNeeded(assistantId, runId);
      }}
    />
  );
}

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
  onOpenDetail: (id) => useViewerStore.getState().openWorkflowDetail(id),
  onStop: (id) => void useWorkflowStore.getState().abortRun(id),
  DetailPanel: WorkflowDetailPanelAdapter,
};
