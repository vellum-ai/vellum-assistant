import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { conversations } from "./schema/index.js";

/**
 * The durable spawn parent of a conversation: the `parent_conversation_id`
 * column stamped at subagent bootstrap. Returns `undefined` for a conversation
 * with no recorded parent or no row at all.
 *
 * Unlike the in-memory conversation registry — which drops a subagent entry as
 * soon as its run goes terminal and evicts idle top-level conversations — this
 * survives for the life of the row, so an ancestry walk still resolves long
 * after the run that created the chain has finished.
 *
 * A single-row primary-key lookup.
 */
export function getPersistedParentConversationId(
  conversationId: string,
): string | undefined {
  const row = getDb()
    .select({ parentConversationId: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.parentConversationId ?? undefined;
}
