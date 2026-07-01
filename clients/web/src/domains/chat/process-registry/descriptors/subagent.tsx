/**
 * The `subagent` {@link BackgroundProcessDescriptor} — the registry entry that
 * projects the subagent store into the shared inline-card + overlay-pill +
 * detail-panel surface.
 */

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
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
 * `useActiveIds` contract takes no arguments, so the conversation scoping is
 * resolved here from the conversation store.
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
 *
 * Title = the subagent's `label` (its task name), so labeled/multiple subagents
 * read distinctly instead of all showing the generic activity verb; falls back
 * to the live `currentStepTitle` when there's no label. The info line keeps the
 * live activity (`currentStepInfo`), but falls back to `currentStepTitle` when
 * it would just echo the label-as-title.
 */
function useCardSummary(id: string): CardSummary | null {
  const label = useSubagentStore((s) => s.byId[id]?.label);
  const data = useSubagentCardData(id);
  if (data === null) return null;
  const title = label ?? data.currentStepTitle;
  const info =
    data.currentStepInfo && data.currentStepInfo !== label
      ? data.currentStepInfo
      : data.currentStepTitle;
  return {
    state: data.state,
    title,
    info,
    count: data.stepCount,
  };
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
        className="[&:not(:first-child)]:-ml-1 [&:not(:first-child)]:rounded-full [&:not(:first-child)]:ring-2 [&:not(:first-child)]:ring-[var(--surface-lift)]"
      />
    ),
    max: MAX_VISIBLE_SUBAGENT_AVATARS,
  },
  overlayTitle: (n) => `${n} Active Subagent${n === 1 ? "" : "s"}`,
  pillAriaLabel: () => "Active subagents",
  openCardAriaLabel: "Open subagent",
  stopAriaLabel: "Stop subagent",
  onOpenDetail: (id) =>
    useViewerStore.getState().openProcessDetail({ kind: "subagent", id }),
  onStop: (id) => void useSubagentStore.getState().abortSubagent(id),
};
