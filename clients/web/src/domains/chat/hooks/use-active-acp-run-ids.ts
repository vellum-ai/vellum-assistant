import { useShallow } from "zustand/react/shallow";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { isActiveAcpStatus } from "@/utils/acp-run-status";

/**
 * Active (initializing | running) ACP run ids in stable `orderedIds` order.
 * `useShallow` keeps the returned array reference stable across unrelated
 * store ticks (e.g. token-usage updates) so consumers only re-render when the
 * active set actually changes.
 */
export function useActiveAcpRunIds(): string[] {
  return useAcpRunStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const status = s.byId[id]?.status;
        return status !== undefined && isActiveAcpStatus(status);
      }),
    ),
  );
}
