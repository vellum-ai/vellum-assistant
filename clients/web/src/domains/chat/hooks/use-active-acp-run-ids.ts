import { useShallow } from "zustand/react/shallow";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { isActiveAcpStatus } from "@/utils/acp-run-status";

/**
 * Active (initializing | running) ACP run ids for `conversationId`, in stable
 * `orderedIds` order. The store is global (all conversations' runs), so the
 * results are scoped by the run's `parentConversationId` to keep a run spawned
 * in another conversation from surfacing here. A run whose parent conversation
 * is unknown (older daemon / rehydrated with `""`) can't be placed, so it stays
 * visible rather than disappearing.
 *
 * `useShallow` keeps the returned array reference stable across unrelated store
 * ticks (e.g. token-usage updates) so consumers only re-render when the active
 * set actually changes.
 */
export function useActiveAcpRunIds(conversationId: string | null): string[] {
  return useAcpRunStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const entry = s.byId[id];
        if (entry?.status === undefined || !isActiveAcpStatus(entry.status)) {
          return false;
        }
        return (
          !entry.parentConversationId ||
          entry.parentConversationId === conversationId
        );
      }),
    ),
  );
}
