import { SubagentStatusSchema } from "@vellumai/assistant-api";

import type { SubagentStore } from "@/domains/chat/subagent-store";
import { isActiveStatus } from "@/utils/subagent-status";

type SubagentStoreSlice = Pick<
  SubagentStore,
  | "byId"
  | "reset"
  | "spawnSubagent"
  | "changeStatus"
  | "setConversationId"
  | "setParentConversationId"
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
 *
 * `parentConversationId` is the conversation being hydrated — it scopes the
 * Active-Subagents overlay. A notification's own `conversationId` is the
 * subagent's (child) conversation, used only for detail fetch.
 */
export function reconcileSubagentStoreFromNotifications(
  store: SubagentStoreSlice,
  notifications: Iterable<SubagentNotificationLike>,
  parentConversationId: string,
  now: number,
): void {
  const priorById = store.byId;
  const hasInFlight = Object.values(priorById).some((entry) =>
    isActiveStatus(entry.status),
  );

  // An empty store has nothing to clear, and `reset()` is not free: it
  // invalidates any in-flight `reconcileFromDaemon` as belonging to a
  // conversation the user left. History hydration races that request on load,
  // and discarding it would lose exactly the rows it exists to recover — a
  // mid-run subagent that has streamed nothing and so appears in no
  // notification.
  if (!hasInFlight && Object.keys(priorById).length > 0) {
    store.reset();
  }

  for (const n of notifications) {
    const parsed = SubagentStatusSchema.safeParse(n.status);
    if (hasInFlight && priorById[n.subagentId]) {
      // An unparseable status carries no information about a live entry —
      // keep whatever the stream told us rather than flipping it terminal.
      if (parsed.success) {
        store.changeStatus({ subagentId: n.subagentId, status: parsed.data });
      }
      if (n.conversationId) {
        store.setConversationId(n.subagentId, n.conversationId);
      }
      store.setParentConversationId(n.subagentId, parentConversationId);
    } else {
      store.spawnSubagent({
        subagentId: n.subagentId,
        label: n.label,
        objective: "",
        // A notification for an unknown subagent with no parseable status is
        // historical, so a terminal default is the safe read.
        status: parsed.success ? parsed.data : "completed",
        error: n.error,
        conversationId: n.conversationId,
        parentConversationId,
        timestamp: now,
        parentMessageId: n.parentMessageId,
      });
    }
  }
}
