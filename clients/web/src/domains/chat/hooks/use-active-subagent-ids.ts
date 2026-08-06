import { useShallow } from "zustand/react/shallow";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { isActiveStatus } from "@/utils/subagent-status";

/**
 * Active (running | pending | awaiting_input) subagent ids for `conversationId`,
 * in stable `orderedIds` order. The store is global (all conversations'
 * subagents), so the results are scoped by the entry's `parentConversationId`,
 * the conversation whose turn spawned it, assigned at spawn or hydration, to
 * keep one spawned in another conversation from surfacing here. (The entry's
 * own `conversationId` is the subagent's child conversation, used only for
 * detail fetch; it never equals the viewed conversation.) An entry without a
 * parent id yet is unknown and stays visible rather than disappearing.
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
          entry.parentConversationId === undefined ||
          entry.parentConversationId === conversationId
        );
      }),
    ),
  );
}
