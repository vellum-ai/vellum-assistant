/**
 * `BackgroundProcessDescriptor` for ACP runs — the registry projection of the
 * existing acp-run inline-card / detail-panel / overlay-pill surface.
 *
 * Behavior-preserving: every axis maps onto a symbol the current ACP UI
 * already uses, so the generic registry renders the same agent-glyph leading
 * mark, the same stacked `AcpAgentChip` pill, and the same `warning` state for
 * a cancelled-completed run.
 */

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { useAcpRunCardData } from "@/domains/chat/components/acp-run-inline-card/use-acp-run-card-data";
import { AcpRunDetailPanel } from "@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel";
import { useActiveAcpRunIds } from "@/domains/chat/hooks/use-active-acp-run-ids";
import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";
import { stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

// Visible agent-mark cap before the "+N" overflow. Mirrors the literal in
// `active-acp-runs-pill.tsx` (and the subagents pill) so the registry pill caps
// at the same count as the surface it generalizes.
const MAX_VISIBLE_ACP_AGENTS = 6;

/**
 * No-arg active-id hook for the descriptor. `useActiveAcpRunIds` is scoped to a
 * conversation (the store is global across conversations), so resolve the
 * currently-selected conversation reactively here and feed it in — the
 * descriptor contract is `() => Id[]`, with no place to thread an argument.
 */
function useActiveIds(): string[] {
  const conversationId = useConversationStore.use.activeConversationId();
  return useActiveAcpRunIds(conversationId);
}

/**
 * Project the ACP run's card data into the shared {@link CardSummary} shape.
 * `useAcpRunCardData` already emits the `ToolProgressCardState` (including
 * `warning` for a cancelled-completed run); this only renames its fields.
 */
function useCardSummary(id: string): CardSummary | null {
  const data = useAcpRunCardData(id);
  if (!data) return null;
  return {
    state: data.state,
    title: data.currentStepTitle,
    info: data.currentStepInfo,
    count: data.stepCount,
  };
}

/**
 * Leading glyph for the inline card — the run's backing agent brand mark.
 * Subscribes reactively to the run's `agent` (no `getState()`) so the glyph
 * updates if the agent string changes mid-run.
 */
function AcpRunCardLeading({ id }: { id: string }) {
  const agent = useAcpRunStore((s) => s.byId[id]?.agent);
  return <AcpAgentIcon agent={agent} />;
}

/**
 * One stacked brand mark for the overlay pill, keyed off the run's backing
 * agent. Owns its own stacking offset via `:not(:first-child)` so the generic
 * `StackedChipsPill` (which maps over ids without an index) reproduces the
 * overlapping-marks layout of the original `ActiveAcpRunsPill` chip exactly.
 */
function AcpAgentChip({ id }: { id: string }) {
  const agent = useAcpRunStore((s) => s.byId[id]?.agent);
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)] [&:not(:first-child)]:-ml-1 [&:not(:first-child)]:ring-2 [&:not(:first-child)]:ring-[var(--surface-lift)]">
      <AcpAgentIcon agent={agent} className="h-3 w-3" />
    </span>
  );
}

/**
 * Adapter to the descriptor's `{ id; onClose }` detail-panel contract.
 * `AcpRunDetailPanel` takes the full store entry, so resolve it by id here and
 * short-circuit to `null` for an unknown run (the entry is gone / not yet
 * spawned).
 */
function AcpRunDetailPanelById({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const entry = useAcpRunStore((s) => s.byId[id]);
  if (!entry) return null;
  return <AcpRunDetailPanel entry={entry} onClose={onClose} />;
}

export const ACP_RUN_DESCRIPTOR: BackgroundProcessDescriptor = {
  kind: "acp-run",
  useActiveIds,
  useCardSummary,
  renderCardLeading: (id) => <AcpRunCardLeading id={id} />,
  pill: {
    variant: "stacked",
    renderChip: (id) => <AcpAgentChip key={id} id={id} />,
    max: MAX_VISIBLE_ACP_AGENTS,
  },
  overlayTitle: (n) => `${n} Active Run${n === 1 ? "" : "s"}`,
  pillAriaLabel: () => "Active runs",
  openCardAriaLabel: "Open run",
  onOpenDetail: (id) =>
    useViewerStore.getState().openProcessDetail({ kind: "acp-run", id }),
  onStop: (id) => void stopAcpRun(id),
  DetailPanel: AcpRunDetailPanelById,
};
