import { useShallow } from "zustand/react/shallow";

import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { isActiveStatus } from "@/utils/workflow-status";

/**
 * Active workflow run ids (status === "running"), in stable spawn order.
 * `useShallow` keeps the array reference stable across unrelated store ticks
 * (token usage, leaf updates) so the overlay doesn't re-render needlessly.
 */
export function useActiveWorkflowRunIds(): string[] {
  return useWorkflowStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const status = s.byId[id]?.status;
        return status !== undefined && isActiveStatus(status);
      }),
    ),
  );
}
