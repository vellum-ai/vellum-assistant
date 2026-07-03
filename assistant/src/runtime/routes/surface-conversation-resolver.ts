/**
 * Shared helper for resolving the conversation that owns a surface.
 *
 * Used by both `surface-action-routes` (POST /v1/surface-actions) and
 * `surface-content-routes` (GET /v1/surfaces/:surfaceId) so the
 * in-memory-miss → DB-scan → rehydrate flow stays in one place.
 *
 * Why this exists: surfaces live on the in-memory `Conversation` object
 * (`surfaceState` is rebuilt from `ui_surface` blocks in message
 * history by `restoreSurfaceStateFromHistory()` whenever a Conversation
 * is constructed). A bare `findConversation` lookup 404s after daemon
 * restart or LRU eviction even though the surface data is still in the
 * SQLite `messages` table. The DB scan below uses the surfaceId itself
 * as the existence check so `getOrCreateConversation` can't be tricked
 * into materializing a phantom conversation for any caller-supplied id.
 */
import type { Conversation } from "../../daemon/conversation.js";
import {
  findConversation,
  findConversationBySurfaceId,
} from "../../daemon/conversation-registry.js";
import { getOrCreateConversation } from "../../daemon/conversation-store.js";
import { rawGet } from "../../persistence/raw-query.js";

/**
 * Resolve the {@link Conversation} that owns the given surface.
 *
 * Lookup order:
 * 1. In-memory map keyed by `conversationId` (or by `surfaceId` when no
 *    id is supplied).
 * 2. SQLite `messages` table — find the conversation whose history
 *    contains a `ui_surface` block with this `surfaceId`. The result is
 *    validated against the caller's `conversationId` (when supplied) so
 *    a mismatched pair returns `undefined` rather than silently
 *    re-routing to a different conversation.
 * 3. `getOrCreateConversation` rehydrates the row, which triggers
 *    `restoreSurfaceStateFromHistory()` and repopulates `surfaceState`.
 *
 * Returns `undefined` when neither lookup nor DB scan turns up a
 * matching conversation. Callers are expected to translate that into
 * the route-appropriate 404.
 */
export async function resolveSurfaceConversation(
  conversationId: string | null | undefined,
  surfaceId: string,
): Promise<Conversation | undefined> {
  const found = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId(surfaceId);
  if (found) return found;

  // Escape LIKE wildcards so a `surfaceId` like "%" or "_" can't match
  // unrelated rows.
  const escaped = surfaceId.replace(/[\\%_]/g, "\\$&");
  const row = rawGet<{ conversation_id: string }>(
    "surfaceResolver:resolveConversation",
    `SELECT conversation_id FROM messages
     WHERE content LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC
     LIMIT 1`,
    `%"surfaceId":"${escaped}"%`,
  );
  if (!row) return undefined;
  if (conversationId && conversationId !== row.conversation_id)
    return undefined;
  return await getOrCreateConversation(row.conversation_id);
}
