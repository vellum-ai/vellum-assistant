/**
 * Module-level helpers for playground route handlers.
 *
 * These replace the former `PlaygroundRouteDeps` interface — each function
 * imports directly from the owning module rather than going through a
 * dependency-injection layer.
 */

import type { Conversation } from "../../../daemon/conversation.js";
import {
  destroyActiveConversation,
  findConversation,
  getOrCreateConversation,
} from "../../../daemon/conversation-store.js";
import {
  addMessage as addMessageCrud,
  createConversation as createConversationCrud,
  deleteConversation as deleteConversationCrud,
  getConversation as getConversationRow,
} from "../../../memory/conversation-crud.js";
import { listConversationsByTitlePrefix as listByPrefix } from "../../../memory/conversation-queries.js";
import { enqueueMemoryJob } from "../../../memory/jobs-store.js";

/**
 * Resolve a conversation by ID for conv-scoped playground routes.
 *
 * Gates on DB existence first so genuinely-missing IDs return `undefined`
 * (preserving the route handlers' 404 path) rather than triggering
 * `getOrCreateConversation`'s create branch and masking the not-found
 * case. For existing-but-not-loaded rows (e.g. freshly seeded by
 * `POST /playground/seed-conversation`), hydrates the in-memory
 * `Conversation` on demand.
 */
export async function getConversationById(
  id: string,
): Promise<Conversation | undefined> {
  if (!getConversationRow(id)) return undefined;
  // Hydrate via getOrCreateConversation when available (production path).
  // Falls back to the in-memory active map for unit tests where the
  // daemon hasn't wired hydration.
  try {
    return await getOrCreateConversation(id);
  } catch {
    return findConversation(id);
  }
}

/**
 * List non-archived conversations whose title starts with `prefix`.
 */
export function listConversationsByTitlePrefix(prefix: string) {
  return listByPrefix(prefix);
}

/**
 * Delete a conversation by ID, tearing down any in-memory state and
 * enqueuing vector cleanup. Returns `true` when a row was deleted.
 */
export function deleteConversationById(id: string): boolean {
  if (!getConversationRow(id)) return false;
  destroyActiveConversation(id);
  const deleted = deleteConversationCrud(id);
  for (const segId of deleted.segmentIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "segment",
      targetId: segId,
    });
  }
  for (const summaryId of deleted.deletedSummaryIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "summary",
      targetId: summaryId,
    });
  }
  return true;
}

/**
 * Create a conversation with the given title.
 */
export function createPlaygroundConversation(title: string): { id: string } {
  const row = createConversationCrud({ title });
  return { id: row.id };
}

/**
 * Add a message to a conversation, returning its ID.
 */
export async function addPlaygroundMessage(
  conversationId: string,
  role: "user" | "assistant",
  contentJson: string,
  options?: { skipIndexing?: boolean },
): Promise<{ id: string }> {
  const persisted = await addMessageCrud(
    conversationId,
    role,
    contentJson,
    undefined,
    options,
  );
  return { id: persisted.id };
}
