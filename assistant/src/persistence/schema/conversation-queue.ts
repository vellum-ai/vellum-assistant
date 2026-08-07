import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";

/**
 * Durable backing for a conversation's in-memory message queue.
 *
 * A message enqueued while the agent is mid-turn lives in `MessageQueue`'s
 * array until the drain persists it as a real `messages` row. The sender was
 * told `202 { queued: true }`, and this table is what stands behind that
 * acknowledgement: a row lands here when the queue accepts a message and is
 * deleted when the message leaves the queue for good (drained and persisted,
 * cancelled, or discarded with the conversation). The table holds exactly the
 * messages still waiting and is empty whenever no conversation is mid-turn.
 *
 * A separate table rather than rows in `messages`: a waiting message must be
 * invisible to every reader of conversation history until it drains, and
 * `messages` is read directly by dozens of modules (memory indexing, lexical
 * jobs, usage accounting, telemetry). Keeping waiting messages out of that
 * table makes a leak unrepresentable instead of relying on every reader to
 * filter.
 *
 * ## What is deliberately not stored
 *
 * `QueuedMessage` also carries the sender's `authContext` / `trustContext`
 * snapshots and the live `onEvent` sink. None of them persist. The trust and
 * auth snapshots are authorization decisions captured at enqueue; replayed
 * after a restart they would re-grant capabilities their bearer may no longer
 * hold, so recovery stores only `source_actor_principal_id` (who sent it,
 * durable and verifiable) and the drain re-derives what that principal may
 * currently do. The sink cannot survive the restart that makes recovery
 * necessary; recovered messages fall back to conversation-scoped broadcast.
 */
export const conversationQueuedMessages = sqliteTable(
  "conversation_queued_messages",
  {
    /** Server-minted `requestId` (uuidv7), the queue's identity for the message. */
    requestId: text("request_id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Client correlation nonce, echoed back so a sender can match its optimistic row. */
    clientMessageId: text("client_message_id"),
    /** Content as the agent will receive it, recording-intent stripping applied. */
    content: text("content").notNull(),
    /** Original user text when `content` was rewritten; null when they match. */
    displayContent: text("display_content"),
    /** JSON attachment array, bounded by the queue's 50 MB byte budget. */
    attachments: text("attachments"),
    /** JSON metadata bag; carries the suppression markers and turn channel/interface context. */
    metadata: text("metadata"),
    /** JSON transport snapshot taken at enqueue. */
    transport: text("transport"),
    /** Verified requester principal. Identity only; see the note above on trust. */
    sourceActorPrincipalId: text("source_actor_principal_id"),
    /** 0/1: false marks a turn with no interactive user, which skips clarification prompts. */
    isInteractive: integer("is_interactive"),
    /** Per-conversation FIFO ordinal. Steer rewrites it to move a row to the head. */
    sortKey: integer("sort_key").notNull(),
    /** `queued` while waiting; `draining` once a drain took it but has not yet persisted it. */
    state: text("state").notNull().default("queued"),
    /** Wall-clock send time, used as the message's display timestamp. */
    sentAt: integer("sent_at").notNull(),
    /** When this row was written. Distinct from `sentAt` for channel-relayed messages. */
    enqueuedAt: integer("enqueued_at").notNull(),
  },
  (table) => [
    // Recovery reads one conversation's backlog in FIFO order; both columns
    // together so the ordering comes off the index rather than a sort.
    index("idx_conversation_queued_messages_conv_sort").on(
      table.conversationId,
      table.sortKey,
    ),
  ],
);
