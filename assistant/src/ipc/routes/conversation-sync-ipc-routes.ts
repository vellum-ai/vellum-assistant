/**
 * IPC-only route the sidecar workers (schedule, memory) call after persisting
 * a conversation's turn rows.
 *
 * Workers disable SSE seq stamping (`disableStreamSeqStamping`) so the daemon
 * is the sole seq authority; a worker's own `getCurrentSeq()` reports `0` and
 * its `publishConversationMessagesChanged` broadcast reaches no SSE subscriber.
 * Left there, a worker-persisted turn records no snapshot anchor
 * (`conversations.seq` stays NULL/stale) and no live client learns the
 * conversation changed, so an already-open conversation updates only on
 * switch/reload.
 *
 * This route runs the notification on the daemon instead: it records the
 * snapshot anchor from the daemon's own seq authority and republishes the
 * messages-changed invalidation on the daemon's hub, where real subscribers
 * observe it. (How the anchor is chosen so it never claims un-flushed content:
 * see the handler.)
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array. DB-migration
 * readiness gating is applied uniformly by the IPC server (the method is not in
 * `DB_MIGRATION_READINESS_EXEMPT_OPERATIONS`), so it is unavailable until
 * migrations settle; the worker's call is best-effort and tolerates that.
 */

import { z } from "zod";

import { getInflightFlushedContentSeq } from "../../daemon/inflight-turn-registry.js";
import { recordConversationPersistedSeq } from "../../persistence/conversation-crud.js";
import { getCurrentSeq } from "../../runtime/assistant-stream-state.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import {
  publishConversationListAndMetadataChanged,
  publishConversationMessagesChanged,
} from "../../runtime/sync/resource-sync-events.js";
import {
  NOTIFY_CONVERSATION_LIST_CHANGED_IPC_METHOD,
  NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD,
} from "../../runtime/sync/worker-daemon-notify.js";

const NotifyConversationPersistedParamsSchema = z.object({
  conversationId: z.string().min(1),
});

const NotifyConversationListChangedParamsSchema = z.object({
  reason: z.enum([
    "created",
    "renamed",
    "deleted",
    "reordered",
    "seen_changed",
  ]),
  conversationIds: z.array(z.string().min(1)).min(1),
});

/**
 * Record the daemon-issued snapshot anchor for a worker-persisted turn and
 * republish its messages-changed invalidation to the daemon's subscribers.
 */
export function handleNotifyConversationPersisted({
  body = {},
}: RouteHandlerArgs) {
  const { conversationId } =
    NotifyConversationPersistedParamsSchema.parse(body);
  // Anchor at the highest seq whose content the durable rows hold. While the
  // daemon streams a turn into this conversation, its live seq counter runs
  // ahead of flushed content, so a `getCurrentSeq()` anchor would advertise
  // in-flight content the snapshot omits — clients drop those deltas as replays
  // and the streamed text vanishes until the next flush. Cap at the streaming
  // turn's flushed watermark; `undefined` means no turn is in flight, where the
  // live counter is honest (the worker's fresh rows carry no higher seq).
  // `recordConversationPersistedSeq` is raise-only and ignores a non-positive
  // seq, so a cold daemon or an un-flushed turn leaves the anchor as-is.
  const anchor =
    getInflightFlushedContentSeq(conversationId) ?? getCurrentSeq();
  recordConversationPersistedSeq(conversationId, anchor);
  publishConversationMessagesChanged(conversationId);
  return { ok: true };
}

/**
 * Republish a worker's conversation-list-and-metadata invalidation on the
 * daemon's hub, where the SSE subscribers live.
 *
 * A worker turn that changes which rows belong in the list (clearing
 * `archived_at` on a Done conversation it woke) has to reach connected
 * sidebars, and a publish in the worker reaches none of them.
 */
export function handleNotifyConversationListChanged({
  body = {},
}: RouteHandlerArgs) {
  const { reason, conversationIds } =
    NotifyConversationListChangedParamsSchema.parse(body);
  publishConversationListAndMetadataChanged(reason, conversationIds);
  return { ok: true };
}

/**
 * IPC-only conversation-sync methods, keyed by operationId. Registered directly
 * on the assistant IPC server (see `assistant-server.ts`).
 */
export const CONVERSATION_SYNC_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD]: handleNotifyConversationPersisted,
  [NOTIFY_CONVERSATION_LIST_CHANGED_IPC_METHOD]:
    handleNotifyConversationListChanged,
};
