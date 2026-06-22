/**
 * Bounded "recent user messages" query, deliberately kept out of the
 * `conversation-crud` god-module.
 *
 * `conversation-crud` sits in a large import cycle (see `bun run lint:circular`),
 * and the guardian tool-approval source resolver
 * (`notifications/tool-approval-source.ts`) is reached *during* that module's own
 * evaluation via the tool-handler import graph. A runtime import of a
 * `conversation-crud` export from that path resolves against a half-initialized
 * module ("Export named … not found"). This leaf module imports only the DB
 * connection + schema (both outside the cycle), so the resolver can read recent
 * messages without joining it. `MessageRow` is imported type-only (erased), so it
 * adds no runtime edge.
 */

import { and, desc, eq } from "drizzle-orm";

import type { MessageRow } from "./conversation-crud.js";
import { getDb } from "./db-connection.js";
import { messages } from "./schema.js";

/**
 * Return up to `limit` of a conversation's most recent `user`-role messages,
 * newest first. A bounded, indexed seek (the `(role, created_at)` index backs the
 * ordering) so callers that only need the latest inbound message — e.g. resolving
 * a guardian card's triggering message — don't materialize the whole history.
 */
export function getRecentUserMessages(
  conversationId: string,
  limit: number,
): MessageRow[] {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
      metadata: row.metadata,
      clientMessageId: row.clientMessageId,
    }));
}
