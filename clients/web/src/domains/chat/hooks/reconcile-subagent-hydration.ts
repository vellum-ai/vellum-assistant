import { SubagentStatusSchema } from "@vellumai/assistant-api";

import type { SubagentStore } from "@/domains/chat/subagent-store";
import { shouldApplyStatus } from "@/utils/subagent-status";

type SubagentStoreSlice = Pick<
  SubagentStore,
  | "byId"
  | "spawnSubagent"
  | "changeStatus"
  | "backfillIdentity"
  | "attachParentMessage"
  | "setConversationId"
  | "setParentConversationId"
>;

export interface SubagentNotificationLike {
  subagentId: string;
  label: string;
  status?: string;
  error?: string;
  conversationId?: string;
  /** Present from daemons that record it on the notification row. */
  objective?: string;
  parentMessageId?: string;
}

/**
 * Apply history subagent notifications to the store as a pure upsert.
 *
 * Hydration never deletes. It is one additive evidence source among several,
 * live SSE and the `/subagents/reconcile` snapshot are the others, and it is
 * the least complete of them: in-flight state streams over SSE rather than
 * appearing in history, and a run that streamed nothing at all (recovered from
 * the daemon's durable rows) has no notification to be represented by. A reset
 * here would delete exactly what the other two recover: a silent run that
 * reconcile resurrected as terminal survives no rebuild-from-notifications,
 * and which one wins would come down to whichever request finished first.
 *
 * Entry lifecycle cleanup is owned elsewhere: cross-conversation clearing by
 * the conversation-change reset (`use-conversation-change-effects`' layout
 * effect and `navigateToConversation`), staleness by reconcile's generation
 * guard, and stuck-active settling by reconcile's orphan pass.
 *
 * `parentConversationId` is the conversation being hydrated, it scopes the
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

  for (const n of notifications) {
    const parsed = SubagentStatusSchema.safeParse(n.status);
    const existing = priorById[n.subagentId];
    if (existing) {
      // An unparseable status carries no information about an entry we
      // already hold: keep what SSE or reconcile told us rather than
      // flipping it terminal.
      if (parsed.success && shouldApplyStatus(existing.status, parsed.data)) {
        store.changeStatus({ subagentId: n.subagentId, status: parsed.data });
      }
      // A stub materialized from a bare status event is "known" but blank:
      // the notification is the first thing to name it. Placeholder yields,
      // established identity wins.
      store.backfillIdentity({
        subagentId: n.subagentId,
        label: n.label,
        objective: n.objective,
      });
      // Entries reconcile materialized carry no parent message id, so nothing
      // has indexed them in `byParent` and the transcript can't place their
      // inline card. The notification is the only source that names the
      // spawning message.
      if (n.parentMessageId) {
        store.attachParentMessage(n.subagentId, n.parentMessageId);
      }
      if (n.conversationId) {
        store.setConversationId(n.subagentId, n.conversationId);
      }
      store.setParentConversationId(n.subagentId, parentConversationId);
    } else {
      store.spawnSubagent({
        subagentId: n.subagentId,
        label: n.label,
        objective: n.objective ?? "",
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
