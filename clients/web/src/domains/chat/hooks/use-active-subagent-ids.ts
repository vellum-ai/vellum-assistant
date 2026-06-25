import { useShallow } from "zustand/react/shallow";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { isActiveStatus } from "@/utils/subagent-status";

/**
 * Active (running | pending | awaiting_input) subagent ids in stable
 * `orderedIds` order. `useShallow` keeps the returned array reference
 * stable across unrelated store ticks (e.g. token-usage updates) so
 * consumers only re-render when the active set actually changes.
 */
export function useActiveSubagentIds(): string[] {
  return useSubagentStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const status = s.byId[id]?.status;
        return status !== undefined && isActiveStatus(status);
      }),
    ),
  );
}
