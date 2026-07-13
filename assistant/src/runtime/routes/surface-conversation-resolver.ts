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
import type {
  SurfaceData,
  SurfaceType,
} from "../../daemon/message-types/surfaces.js";
import { rawAll, rawGet } from "../../persistence/raw-query.js";
import {
  type ActivationMomentParam,
  isActivationMomentParam,
} from "../../telemetry/activation-funnel.js";

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

/**
 * A `ui_surface` block extracted from persisted history, in the shape of a
 * `Conversation.surfaceState` entry so callers can memoize it directly.
 */
export interface PersistedSurfaceState {
  surfaceType: SurfaceType;
  data: SurfaceData;
  title?: string;
  actions?: Array<{
    id: string;
    label: string;
    style?: string;
    data?: Record<string, unknown>;
  }>;
  activationMoment?: ActivationMomentParam;
}

/**
 * Find the `ui_surface` block for `surfaceId` in the conversation's
 * PERSISTED message history and map it to the `surfaceState` entry shape.
 *
 * Why this exists: `surfaceState` is only rebuilt from history when a
 * Conversation is constructed (`restoreSurfaceStateFromHistory`). A surface
 * appended out-of-band — `addMessage` against an already-loaded
 * conversation, as the memory retrospective's skill card does — lands in
 * the messages table without ever touching the live object's map, so an
 * in-memory registry hit resolves a conversation whose `surfaceState`
 * predates the insert and the content lookup 404s. (An evicted
 * conversation works: rehydration rescans history.)
 *
 * The newest matching message wins, mirroring
 * `restoreSurfaceStateFromHistory`'s forward scan where a later write to
 * the same `surfaceId` overwrites an earlier one. The LIKE pre-filter is an
 * index-friendly candidate probe only — the parsed block is what confirms
 * the exact `surfaceId` (a message merely quoting the id in text parses to
 * no matching block and the scan moves on).
 *
 * `liveHistoryStartRow` preserves the compaction boundary: the live history
 * is `getMessages(...).slice(contextCompactedMessageCount)` (`loadFromDb`),
 * and `restoreSurfaceStateFromHistory` deliberately never sees the
 * compacted-away prefix — stale surface ids are not globally unique, so
 * resurrecting one here would let later surface-action routing operate on
 * state the compaction dropped. The scan skips that same prefix (rows are
 * numbered in the store's `created_at ASC` order).
 */
export function findPersistedSurfaceState(
  conversationId: string,
  surfaceId: string,
  liveHistoryStartRow: number,
): PersistedSurfaceState | undefined {
  // Escape LIKE wildcards so a `surfaceId` like "%" or "_" can't match
  // unrelated rows.
  const escaped = surfaceId.replace(/[\\%_]/g, "\\$&");
  const rows = rawAll<{ content: string }>(
    "surfaceResolver:findPersistedSurface",
    `SELECT content FROM (
       SELECT content, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
       FROM messages
       WHERE conversation_id = ?
     )
     WHERE rn > ? AND content LIKE ? ESCAPE '\\'
     ORDER BY rn DESC
     LIMIT 10`,
    conversationId,
    Math.max(0, Math.floor(liveHistoryStartRow)),
    `%"surfaceId":"${escaped}"%`,
  );
  for (const row of rows) {
    let blocks: unknown;
    try {
      blocks = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== "ui_surface" || b.surfaceId !== surfaceId) continue;
      // Same field mapping and validation as
      // `restoreSurfaceStateFromHistory` — a malformed daemon-only
      // `activationMoment` is dropped, never served or memoized.
      const activationMoment =
        typeof b.activationMoment === "string" &&
        isActivationMomentParam(b.activationMoment)
          ? b.activationMoment
          : undefined;
      return {
        surfaceType: (b.surfaceType ?? "dynamic_page") as SurfaceType,
        data: (b.data ?? {}) as SurfaceData,
        title: b.title as string | undefined,
        actions: Array.isArray(b.actions)
          ? (b.actions as PersistedSurfaceState["actions"])
          : undefined,
        ...(activationMoment ? { activationMoment } : {}),
      };
    }
  }
  return undefined;
}
