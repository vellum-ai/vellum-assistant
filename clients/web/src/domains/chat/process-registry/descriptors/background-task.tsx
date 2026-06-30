/**
 * Background-process descriptor for bash / host_bash background tasks.
 *
 * This is the count-less kind: unlike subagents ("3 agents") or workflows
 * ("5 steps"), a background task has no meaningful unit count, so its
 * {@link CardSummary} omits `count` and the inline card leads with a
 * tool-keyed terminal glyph (`bash` → square-terminal, `host_bash` →
 * file-terminal) instead of an avatar.
 *
 * Behavior-preserving: every projection here mirrors the existing
 * `useBackgroundTaskCardData`, `ActiveBackgroundTasksPill`, and
 * `BackgroundTaskDetailPanel` surfaces — see the per-field notes below.
 */

import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { BackgroundTaskGlyph } from "@/domains/chat/components/background-task-glyph";
import { BackgroundTaskDetailPanel } from "@/domains/chat/components/background-task-detail-panel/background-task-detail-panel";
import { useBackgroundTaskCardData } from "@/domains/chat/components/background-task-inline-card/use-background-task-card-data";
import { useActiveBackgroundTaskIds } from "@/domains/chat/hooks/use-active-background-task-ids";
import { stopBackgroundTask } from "@/domains/chat/utils/background-task-actions";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Cap on stacked terminal glyphs before the overlay pill collapses the
 * remainder to "+N". Mirrors the local cap in `ActiveBackgroundTasksPill`,
 * which is file-private there.
 */
const MAX_VISIBLE_BACKGROUND_TASK_GLYPHS = 6;

/**
 * Active background-task ids for the currently-selected conversation.
 *
 * The descriptor contract's `useActiveIds` is zero-arg, but
 * `useActiveBackgroundTaskIds` is conversation-scoped (the store is global
 * across conversations). Bind it to the active conversation id here so the
 * registry sees only the tasks for the conversation on screen — exactly what
 * `ChatRouteContent` does today.
 */
function useActiveIds(): string[] {
  const conversationId = useConversationStore((s) => s.activeConversationId);
  return useActiveBackgroundTaskIds(conversationId);
}

/**
 * Leading slot of the inline card: a tool-keyed terminal glyph. Subscribes
 * reactively to just this task's `toolName` so the glyph swaps if the entry
 * lands after the card mounts (the start race). Falls back to `bash` when the
 * entry isn't present yet, matching the overlay pill's fallback.
 */
function BackgroundTaskCardLeading({ id }: { id: string }) {
  const toolName = useBackgroundTaskStore((s) => s.byId[id]?.toolName);
  return <BackgroundTaskGlyph toolName={toolName ?? "bash"} />;
}

/**
 * One stacked chip for the overlay pill. The chip owns its own stacking offset
 * (`-ml-1 ring-2` for every chip past the first) since `StackedChipsPill`
 * passes only `id`, not an index — mirroring the original pill's per-glyph
 * offset.
 */
function BackgroundTaskChip({ id }: { id: string }) {
  const toolName = useBackgroundTaskStore((s) => s.byId[id]?.toolName);
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded bg-[var(--surface-lift)] [&:not(:first-child)]:-ml-1 [&:not(:first-child)]:ring-2 [&:not(:first-child)]:ring-[var(--surface-lift)]">
      <BackgroundTaskGlyph
        toolName={toolName ?? "bash"}
        className="h-3.5 w-3.5 text-[var(--content-emphasised)]"
      />
    </span>
  );
}

/**
 * Adapter from the registry's `{ id; onClose }` detail-panel contract to
 * `BackgroundTaskDetailPanel`'s `{ entry; onClose }` shape. Resolves the live
 * store entry by id; renders `null` when no entry exists (e.g. the panel was
 * opened for a task that has since been cleared), matching how the existing
 * call sites guard on the resolved entry being present.
 */
function BackgroundTaskDetailPanelAdapter({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const entry = useBackgroundTaskStore((s) => s.byId[id]);
  if (!entry) return null;
  return <BackgroundTaskDetailPanel entry={entry} onClose={onClose} />;
}

export const BACKGROUND_TASK_DESCRIPTOR: BackgroundProcessDescriptor = {
  kind: "background-task",
  useActiveIds,
  useCardSummary: (id) => {
    const data = useBackgroundTaskCardData(id);
    if (!data) return null;
    // No `count`: a background task has no meaningful unit count. `toolName`
    // drives `renderCardLeading`, not the summary.
    return { state: data.state, title: data.title, info: data.info };
  },
  renderCardLeading: (id) => <BackgroundTaskCardLeading id={id} />,
  pill: {
    variant: "stacked",
    renderChip: (id) => <BackgroundTaskChip key={id} id={id} />,
    max: MAX_VISIBLE_BACKGROUND_TASK_GLYPHS,
  },
  overlayTitle: (count) => `${count} Active Command${count === 1 ? "" : "s"}`,
  pillAriaLabel: () => "Active commands",
  openCardAriaLabel: "Open command",
  onOpenDetail: (id) => useViewerStore.getState().openBackgroundTaskDetail(id),
  onStop: (id) => void stopBackgroundTask(id),
  DetailPanel: BackgroundTaskDetailPanelAdapter,
};
