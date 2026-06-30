/**
 * The `subagent` {@link BackgroundProcessDescriptor} — the registry entry that
 * projects the subagent store into the shared inline-card + overlay-pill +
 * detail-panel surface.
 *
 * Behaviour-preserving: every field mirrors what the bespoke subagent surface
 * already renders (the inline progress card, the active-subagents overlay/pill,
 * and the subagent detail panel). Nothing consumes this descriptor yet — the
 * registry + generic surface wiring lands in a later PR.
 */

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel";
import { MAX_VISIBLE_SUBAGENT_AVATARS } from "@/domains/chat/components/subagent-inline-progress-card/subagent-avatar-row";
import { useActiveSubagentIds } from "@/domains/chat/hooks/use-active-subagent-ids";
import { useSubagentCardData } from "@/domains/chat/hooks/use-subagent-card-data";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

import type {
  BackgroundProcessDescriptor,
  CardSummary,
} from "@/domains/chat/process-registry/types";

/**
 * Active subagent ids for the current conversation. The descriptor's
 * `useActiveIds` contract takes no arguments, so the conversation scoping the
 * bespoke surface applies (`useActiveSubagentIds(activeConversationId)` in
 * `chat-route-content`) is resolved here from the conversation store.
 */
function useActiveIds(): string[] {
  const activeConversationId = useConversationStore.use.activeConversationId();
  return useActiveSubagentIds(activeConversationId);
}

/**
 * Project the subagent's `ToolCallCardData` into the shared {@link CardSummary}
 * shape. Returns `null` in the spawn-race window (no entry yet), preserving the
 * inline card's short-circuit. The 4-value `ToolCallCardData["state"]` is a
 * subset of `ToolProgressCardState` (it never emits `warning`/`denied`), so it
 * passes through unchanged.
 */
function useCardSummary(id: string): CardSummary | null {
  const data = useSubagentCardData(id);
  if (data === null) return null;
  return {
    state: data.state,
    title: data.currentStepTitle,
    info: data.currentStepInfo,
    count: data.stepCount,
  };
}

/**
 * Detail-panel adapter: the shared descriptor renders `DetailPanel` with an
 * `{ id, onClose }` contract, but `SubagentDetailPanel` reads its `entry` from
 * the store. Resolve the entry by id here and short-circuit to `null` when it's
 * absent (spawn race / cleared), matching the inline surface.
 */
function SubagentDetailPanelById({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const entry = useSubagentStore((s) => s.byId[id]);
  if (!entry) return null;
  return <SubagentDetailPanel entry={entry} onClose={onClose} />;
}

export const SUBAGENT_DESCRIPTOR: BackgroundProcessDescriptor = {
  kind: "subagent",
  useActiveIds,
  useCardSummary,
  renderCardLeading: (id) => <SubagentAvatarChip subagentId={id} size={16} />,
  pill: {
    variant: "stacked",
    renderChip: (id) => (
      <SubagentAvatarChip
        key={id}
        subagentId={id}
        size={16}
        className="-ml-1 ring-2 ring-[var(--surface-lift)]"
      />
    ),
    max: MAX_VISIBLE_SUBAGENT_AVATARS,
  },
  overlayTitle: (n) => `${n} Active Subagent${n === 1 ? "" : "s"}`,
  pillAriaLabel: () => "Active subagents",
  openCardAriaLabel: "Open subagent",
  onOpenDetail: (id) =>
    useViewerStore.getState().openProcessDetail({ kind: "subagent", id }),
  onStop: (id) => void useSubagentStore.getState().abortSubagent(id),
  DetailPanel: SubagentDetailPanelById,
};
