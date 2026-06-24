import type { SubagentStatus } from "@vellumai/assistant-api";

import type { SubagentStore } from "@/domains/chat/subagent-store";
import { isActiveStatus } from "@/utils/subagent-status";

type SubagentStoreSlice = Pick<
  SubagentStore,
  "byId" | "reset" | "spawnSubagent" | "changeStatus" | "setConversationId"
>;

export interface SubagentNotificationLike {
  subagentId: string;
  label: string;
  status?: string;
  error?: string;
  conversationId?: string;
  parentMessageId?: string;
}

/**
 * Apply history subagent notifications to the store while preserving live
 * (in-flight) subagents.
 *
 * In-flight subagent state streams from SSE, not history notifications, so a
 * blanket reset drops a subagent that's still running when the conversation
 * re-hydrates (e.g. after a tab switch). When nothing is in flight we rebuild
 * from scratch — clearing the prior conversation's terminal entries. When a
 * subagent is in flight we merge instead: upsert notified subagents and apply a
 * terminal status to a live entry that just finished, without discarding its
 * streamed events.
 */
export function reconcileSubagentStoreFromNotifications(
  store: SubagentStoreSlice,
  notifications: Iterable<SubagentNotificationLike>,
  now: number,
): void {
  const priorById = store.byId;
  const hasInFlight = Object.values(priorById).some((entry) =>
    isActiveStatus(entry.status),
  );

  if (!hasInFlight) store.reset();

  for (const n of notifications) {
    const status = (n.status as SubagentStatus) || "completed";
    if (hasInFlight && priorById[n.subagentId]) {
      store.changeStatus({ subagentId: n.subagentId, status });
      if (n.conversationId) {
        store.setConversationId(n.subagentId, n.conversationId);
      }
    } else {
      store.spawnSubagent({
        subagentId: n.subagentId,
        label: n.label,
        objective: "",
        status,
        error: n.error,
        conversationId: n.conversationId,
        timestamp: now,
        parentMessageId: n.parentMessageId,
      });
    }
  }
}
