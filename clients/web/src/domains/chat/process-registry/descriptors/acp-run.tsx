/**
 * `BackgroundProcessDescriptor` for ACP runs — projects the acp-run store into
 * the shared inline-card / detail-panel / overlay-pill surface, rendering an
 * agent-glyph leading mark, a stacked `AcpAgentChip` pill, and the `warning`
 * state for a cancelled-completed run.
 */

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { useAcpRunCardData } from "@/domains/chat/components/acp-run-inline-card/use-acp-run-card-data";
import { useActiveAcpRunIds } from "@/domains/chat/hooks/use-active-acp-run-ids";
import { MAX_VISIBLE_STACKED_CHIPS } from "@/domains/chat/process-registry/constants";
import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";
import { stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

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

export const ACP_RUN_DESCRIPTOR: BackgroundProcessDescriptor = {
  kind: "acp-run",
  useActiveIds,
  useCardSummary,
  renderCardLeading: (id) => <AcpRunCardLeading id={id} />,
  pill: {
    variant: "stacked",
    renderChip: (id) => <AcpAgentChip key={id} id={id} />,
    max: MAX_VISIBLE_STACKED_CHIPS,
  },
  overlayTitle: (n) => `${n} Active Run${n === 1 ? "" : "s"}`,
  pillAriaLabel: () => "Active runs",
  openCardAriaLabel: "Open run",
  onOpenDetail: (id) =>
    useViewerStore.getState().openProcessDetail({ kind: "acp-run", id }),
  // `stopAcpRun` can reject (offline / non-OK / no active assistant); report
  // instead of leaving an unhandled rejection. Mirrors the bespoke callers.
  onStop: (id) =>
    void stopAcpRun(id).catch((err) => {
      captureError(err, { context: "AcpRunDescriptor.stop" });
    }),
};
