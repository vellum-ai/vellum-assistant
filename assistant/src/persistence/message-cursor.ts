// ---------------------------------------------------------------------------
// Message cursors: the "(createdAt, id) after which" reference behind the
// messages-after reads, resilient to the referenced row being deleted.
// ---------------------------------------------------------------------------
//
// A bare message id bounds a read only while its row exists. A regenerated
// reply (the conversation retry route discards the latest assistant turn) or a
// retried turn deletes the row, and a caller holding just the id can no longer
// say where it sat. A `MessageCursor` carries the row's `createdAt` alongside
// its id, so the `(createdAt, id)` bound is reconstructible from the cursor
// alone. The live row stays authoritative whenever it exists.

import { eq } from "drizzle-orm";

import type { LineageBound } from "./conversation-lineage.js";
import { getDb } from "./db-connection.js";
import { messages } from "./schema/index.js";

export { messagesAfterBoundFilter } from "./conversation-lineage.js";

/**
 * A `(createdAt, id)` message reference. `createdAt` is null when the holder
 * never recorded it; such a cursor bounds a read only while its row exists.
 */
export interface MessageCursor {
  readonly id: string;
  readonly createdAt: number | null;
}

/**
 * Accepted "after" references: a message id, a {@link MessageCursor}, or
 * null. `null`, `""`, and a cursor whose id is `""` all mean "no lower bound".
 */
export type MessagesAfterRef = string | MessageCursor | null;

/** Where a messages-after read starts. */
export type MessagesAfterBound =
  /** No lower bound: every row the conversation owns. */
  | { kind: "all" }
  /** Rows strictly after `bound` in `(createdAt, id)` order. */
  | { kind: "after"; bound: LineageBound }
  /**
   * The referenced row is gone and the reference carried no timestamp, so
   * the read has no defensible starting point. Readers return nothing.
   */
  | { kind: "vanished" };

/** The `(createdAt, id)` bound of a single message, or null when it is gone. */
export function loadMessageBound(messageId: string): LineageBound | null {
  const row = getDb()
    .select({ createdAt: messages.createdAt, id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  return row ?? null;
}

/**
 * Resolve an "after" reference to the bound a read filters on. A live row
 * wins; a cursor whose row is gone falls back to the `createdAt` it carries,
 * paired with its id so same-millisecond neighbours keep their order.
 */
export function resolveMessagesAfterBound(
  after: MessagesAfterRef,
): MessagesAfterBound {
  const id = typeof after === "string" ? after : (after?.id ?? "");
  if (id === "") {
    return { kind: "all" };
  }
  const live = loadMessageBound(id);
  if (live) {
    return { kind: "after", bound: live };
  }
  if (typeof after === "object" && after !== null && after.createdAt !== null) {
    return { kind: "after", bound: { createdAt: after.createdAt, id } };
  }
  return { kind: "vanished" };
}
