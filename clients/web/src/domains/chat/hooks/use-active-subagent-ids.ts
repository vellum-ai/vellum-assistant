import { useShallow } from "zustand/react/shallow";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { isActiveStatus } from "@/utils/subagent-status";

/**
 * Active (running | pending | awaiting_input) subagent ids for `conversationId`,
 * in stable `orderedIds` order. The store is global (all conversations'
 * subagents), so the results are scoped by the subagent's `conversationId` to
 * keep one spawned in another conversation from surfacing here. `conversationId`
 * is assigned after spawn (via `subagent_event`), so an entry that hasn't
 * received it yet is unknown and stays visible rather than disappearing.
 *
 * `useShallow` keeps the returned array reference stable across unrelated store
 * ticks (e.g. token-usage updates) so consumers only re-render when the active
 * set actually changes.
 */
export function useActiveSubagentIds(conversationId: string | null): string[] {
  return useSubagentStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const entry = s.byId[id];
        if (entry?.status === undefined || !isActiveStatus(entry.status)) {
          return false;
        }
        return (
          entry.conversationId === undefined ||
          entry.conversationId === conversationId
        );
      }),
    ),
  );
}
