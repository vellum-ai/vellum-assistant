/**
 * Named read accessors for the `messages` table.
 *
 * Every row in `messages` is conversation content in some state of
 * completeness: `finalized = 1` rows are immutable history, `finalized = 0`
 * rows are still being written and their `content` may be a `{ ref }` into an
 * in-flight delta file that disappears when the turn completes. Ad-hoc queries
 * tend to encode a visibility decision without stating it; each accessor here
 * states its decision in its name and contract, so a caller (and a reviewer)
 * chooses between "completed history" and "any row" deliberately.
 *
 * Conversation-history reads (transcripts, lineage, pagination) stay with
 * `getMessages` / `getMessagesAfter` / `getMessagesPaginated` in
 * `conversation-crud.ts`, which also own fork-lineage resolution. This module
 * is for the narrower point lookups and aggregates that other persistence
 * modules need.
 *
 * Correlated subqueries embedded inside larger SQL (usage accounting's
 * turn-index arithmetic, search candidate joins, `message_count` projections)
 * are out of scope: extracting them would restructure their host queries. They
 * carry their visibility decision as a comment at the site instead.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { type DrizzleDb, getDb } from "./db-connection.js";
import { messages } from "./schema/index.js";

/** `(id, createdAt)` of a message, the shape cursor and watermark logic needs. */
export interface MessageRef {
  id: string;
  createdAt: number;
}

/**
 * Structural read handle: anything that can `select` like the shared
 * connection, which includes the connection itself and an open transaction.
 * Every accessor takes `opts.db` with this type and defaults to the shared
 * connection, so a caller holding its own handle (a transaction, an injected
 * or in-memory database) reads the same database it writes.
 */
export type MessageReadHandle = Pick<DrizzleDb, "select">;

/**
 * The newest completed assistant message in a conversation, or null when it
 * has none.
 *
 * Finalized-only: an assistant row that is still streaming is not a reply yet,
 * so consumers tracking "the latest reply" (read/unread watermarks, previews)
 * must not anchor on it. The row qualifies on its own once the turn completes.
 *
 * `db` lets a caller inside a transaction read through its own handle.
 */
export function latestAssistantMessage(
  conversationId: string,
  opts?: { db?: MessageReadHandle },
): MessageRef | null {
  return newestFinalizedAssistantRow(conversationId, opts?.db ?? getDb());
}

/**
 * The newest completed assistant message strictly before `createdAt`, or null.
 * Strict comparison: rewind logic that landed on a same-timestamp sibling
 * would classify the latest reply as already seen.
 */
export function latestAssistantMessageBefore(
  conversationId: string,
  createdAt: number,
  opts?: { db?: MessageReadHandle },
): MessageRef | null {
  return newestFinalizedAssistantRow(
    conversationId,
    opts?.db ?? getDb(),
    createdAt,
  );
}

function newestFinalizedAssistantRow(
  conversationId: string,
  db: MessageReadHandle,
  strictlyBefore?: number,
): MessageRef | null {
  const row = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        eq(messages.finalized, 1),
        ...(strictlyBefore === undefined
          ? []
          : [lt(messages.createdAt, strictlyBefore)]),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Raw `content` of the last user-role row in a conversation, in insertion
 * order (`rowid DESC`, not `createdAt`), or null when there is none.
 *
 * Insertion order is load-bearing for the undo path this serves: same-
 * millisecond rows must resolve to the one written last. User rows are always
 * written finalized, so no completeness predicate applies; only assistant
 * turns stream.
 */
export function latestUserMessageRawContent(
  conversationId: string,
  opts?: { db?: MessageReadHandle },
): string | null {
  const row = (opts?.db ?? getDb())
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();
  return row?.content ?? null;
}

/**
 * Per-conversation count and latest timestamp of rows with `role`, for the
 * given conversations.
 *
 * Any-state deliberately: these aggregates feed list ordering and previews,
 * where a streaming reply still counts as activity. A caller needing
 * completed-only aggregates should say so here rather than post-filtering.
 */
export function countMessagesByRoleForConversations(
  conversationIds: string[],
  role: string,
  opts?: { db?: MessageReadHandle },
): Map<string, { count: number; lastAt: number }> {
  if (conversationIds.length === 0) {
    return new Map();
  }
  const rows = (opts?.db ?? getDb())
    .select({
      conversationId: messages.conversationId,
      count: sql<number>`COUNT(*)`.as("count"),
      lastAt: sql<number>`MAX(${messages.createdAt})`.as("last_at"),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        eq(messages.role, role),
      ),
    )
    .groupBy(messages.conversationId)
    .all();
  return new Map(
    rows.map((r) => [
      r.conversationId,
      { count: Number(r.count), lastAt: Number(r.lastAt) },
    ]),
  );
}

/**
 * Which of `messageIds` exist as rows, in any state.
 *
 * Any-state deliberately: existence is the question (orphan detection for
 * rows referencing messages), and a streaming row exists. An empty input
 * returns an empty set without querying.
 */
export function existingMessageIds(
  messageIds: string[],
  opts?: { db?: MessageReadHandle },
): Set<string> {
  if (messageIds.length === 0) {
    return new Set();
  }
  return new Set(
    (opts?.db ?? getDb())
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, messageIds))
      .all()
      .map((r) => r.id),
  );
}

/**
 * The conversation that owns `messageId`, in any state, or null when the
 * message does not exist.
 *
 * Any-state deliberately: callers hold an id the user acted on (a bookmark on
 * a rendered row, an attachment link), and a rendered row may still be
 * streaming.
 */
export function messageConversationId(
  messageId: string,
  opts?: { db?: MessageReadHandle },
): string | null {
  const row = (opts?.db ?? getDb())
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  return row?.conversationId ?? null;
}
