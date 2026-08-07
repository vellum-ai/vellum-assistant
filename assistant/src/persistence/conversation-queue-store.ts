/**
 * Row-level helpers for `conversation_queued_messages`, the durable backing of
 * the in-memory message queue. `MessageQueue` calls these from inside its own
 * mutation methods so the table and the array cannot drift; nothing else
 * should write this table.
 *
 * ## Failure policy
 *
 * Every helper is best-effort: it catches, logs, and returns a degraded value
 * instead of throwing. A queued message whose row fails to write is exactly as
 * durable as every queued message was before this table existed, whereas
 * letting the throw escape would reject a send the queue has already accepted
 * and the sender has already been told about. Reads degrade to an empty
 * backlog, which recovers nothing. This matches the daemon's rule that
 * subsystem failures degrade rather than propagate.
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db-connection.js";
import { conversationQueuedMessages } from "./schema/index.js";

const log = getLogger("conversation-queue-store");

/**
 * The persistable projection of a queued message. Deliberately narrower than
 * the daemon's `QueuedMessage`: that type also carries the live `onEvent`
 * sink and the sender's `authContext` / `trustContext`, none of which may be
 * stored (see the schema module). Mapping down to this shape is the caller's
 * visible step, not an accident of serialization. Attachments, metadata, and
 * transport are opaque JSON here; the daemon owns their types.
 */
export interface PersistableQueuedMessage {
  requestId: string;
  content: string;
  displayContent?: string;
  clientMessageId?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
  transport?: unknown;
  sourceActorPrincipalId?: string;
  isInteractive?: boolean;
  sentAt: number;
}

/** A backlog row read back for recovery, JSON columns parsed. */
export interface RecoveredQueuedMessage extends PersistableQueuedMessage {
  sortKey: number;
  state: "queued" | "draining";
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fromJson<T>(raw: string | null): T | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write the row that stands behind a freshly accepted queued message. Called
 * after the byte-budget accept, so a rejected message never leaves a row.
 *
 * `sort_key` is assigned by the insert itself (max + 1 for the conversation)
 * rather than by an in-process counter: a counter would be one more piece of
 * queue state to keep in agreement, and it would not survive the restart this
 * table exists to survive.
 */
export function insertQueuedRow(
  conversationId: string,
  message: PersistableQueuedMessage,
): void {
  try {
    getDb()
      .insert(conversationQueuedMessages)
      .values({
        requestId: message.requestId,
        conversationId,
        clientMessageId: message.clientMessageId ?? null,
        content: message.content,
        displayContent: message.displayContent ?? null,
        attachments: toJson(message.attachments),
        metadata: toJson(message.metadata),
        transport: toJson(message.transport),
        sourceActorPrincipalId: message.sourceActorPrincipalId ?? null,
        isInteractive:
          message.isInteractive === undefined
            ? null
            : message.isInteractive
              ? 1
              : 0,
        sortKey: sql`(SELECT COALESCE(MAX(sort_key), 0) + 1
          FROM conversation_queued_messages WHERE conversation_id = ${conversationId})`,
        state: "queued",
        sentAt: message.sentAt,
        enqueuedAt: Date.now(),
      })
      .run();
  } catch (err) {
    log.error(
      { err, conversationId, requestId: message.requestId },
      "Failed to persist queued message row; it remains in memory only",
    );
  }
}

/**
 * Mark a row taken by a drain that has not yet persisted its message. The row
 * stays until the drain confirms the persist, so the message is never absent
 * from storage: it is a backlog row or a `messages` row, and briefly both.
 */
export function markDraining(requestId: string): void {
  setRowState(requestId, "draining");
}

/** Return a row to `queued`: a drain gave the message back to the queue. */
export function markQueued(requestId: string): void {
  setRowState(requestId, "queued");
}

function setRowState(requestId: string, state: "queued" | "draining"): void {
  try {
    getDb()
      .update(conversationQueuedMessages)
      .set({ state })
      .where(eq(conversationQueuedMessages.requestId, requestId))
      .run();
  } catch (err) {
    log.error({ err, requestId, state }, "Failed to set queued row state");
  }
}

/**
 * Drop the row for a message that left the queue for good: persisted by a
 * successful drain, cancelled by its sender, or discarded with the
 * conversation.
 */
export function deleteRow(requestId: string): void {
  try {
    getDb()
      .delete(conversationQueuedMessages)
      .where(eq(conversationQueuedMessages.requestId, requestId))
      .run();
  } catch (err) {
    log.error({ err, requestId }, "Failed to delete queued message row");
  }
}

/** Drop every row for a conversation whose queue was cleared wholesale. */
export function deleteRowsForConversation(conversationId: string): void {
  try {
    getDb()
      .delete(conversationQueuedMessages)
      .where(eq(conversationQueuedMessages.conversationId, conversationId))
      .run();
  } catch (err) {
    log.error(
      { err, conversationId },
      "Failed to clear queued message rows for conversation",
    );
  }
}

/**
 * Move a row to the head of its conversation's backlog (steer). One row's
 * sort key moves; siblings keep theirs, so recovery order matches the
 * in-memory order `promoteToHead` produced.
 */
export function promoteRowToHead(
  conversationId: string,
  requestId: string,
): void {
  try {
    getDb()
      .update(conversationQueuedMessages)
      .set({
        sortKey: sql`(SELECT COALESCE(MIN(sort_key), 0) - 1
          FROM conversation_queued_messages WHERE conversation_id = ${conversationId})`,
      })
      .where(
        and(
          eq(conversationQueuedMessages.requestId, requestId),
          eq(conversationQueuedMessages.conversationId, conversationId),
        ),
      )
      .run();
  } catch (err) {
    log.error(
      { err, conversationId, requestId },
      "Failed to promote queued message row",
    );
  }
}

/**
 * The surviving backlog for a conversation, FIFO. `draining` rows are
 * returned alongside `queued` ones: a drain that did not live to confirm its
 * persist never really took the message.
 */
export function loadRows(conversationId: string): RecoveredQueuedMessage[] {
  try {
    const rows = getDb()
      .select()
      .from(conversationQueuedMessages)
      .where(eq(conversationQueuedMessages.conversationId, conversationId))
      .orderBy(asc(conversationQueuedMessages.sortKey))
      .all();
    return rows.map((row) => ({
      requestId: row.requestId,
      content: row.content,
      displayContent: row.displayContent ?? undefined,
      clientMessageId: row.clientMessageId ?? undefined,
      attachments: fromJson<unknown[]>(row.attachments) ?? [],
      metadata: fromJson<Record<string, unknown>>(row.metadata),
      transport: fromJson<unknown>(row.transport),
      sourceActorPrincipalId: row.sourceActorPrincipalId ?? undefined,
      isInteractive:
        row.isInteractive === null ? undefined : row.isInteractive === 1,
      sentAt: row.sentAt,
      sortKey: row.sortKey,
      state: row.state === "draining" ? "draining" : "queued",
    }));
  } catch (err) {
    log.error(
      { err, conversationId },
      "Failed to read queued message backlog; recovering nothing",
    );
    return [];
  }
}

/** Conversations with a surviving backlog, for the startup recovery sweep. */
export function listConversationIdsWithRows(): string[] {
  try {
    return getDb()
      .selectDistinct({
        conversationId: conversationQueuedMessages.conversationId,
      })
      .from(conversationQueuedMessages)
      .all()
      .map((row) => row.conversationId);
  } catch (err) {
    log.error({ err }, "Failed to list conversations with queued backlogs");
    return [];
  }
}
