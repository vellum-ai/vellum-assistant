import { useShallow } from "zustand/react/shallow";

import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { isActiveBackgroundTaskStatus } from "@/utils/background-task-status";

/**
 * Active ("running") background-task ids for `conversationId`, in stable
 * `orderedIds` order. The store is global (all conversations' tasks), so the
 * results are scoped by the task's `conversationId` to keep a task spawned in
 * another conversation from surfacing here.
 *
 * `useShallow` keeps the returned array reference stable across unrelated store
 * ticks (e.g. a terminal settling in another conversation) so consumers only
 * re-render when the active set actually changes.
 */
export function useActiveBackgroundTaskIds(
  conversationId: string | null,
): string[] {
  return useBackgroundTaskStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const entry = s.byId[id];
        if (
          entry?.status === undefined ||
          !isActiveBackgroundTaskStatus(entry.status)
        ) {
          return false;
        }
        return entry.conversationId === conversationId;
      }),
    ),
  );
}
