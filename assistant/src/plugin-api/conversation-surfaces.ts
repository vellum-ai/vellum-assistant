/**
 * Plugin-facing read API for conversation UI surfaces.
 *
 * Plugins enumerate current surface snapshots through this facade. The
 * daemon-owned live map, persisted scan, and trust filtering stay behind
 * a dynamic import so this module does not pull the conversation/DB graph
 * into every `@vellumai/plugin-api` consumer.
 */

export interface ConversationSurfaceSnapshot {
  surfaceId: string;
  surfaceType: string;
  data: Record<string, unknown>;
  completed: boolean;
  completionSummary?: string;
}

/**
 * Enumerate the conversation's current UI surface snapshots.
 *
 * Combines unbounded persisted `ui_surface` history with the loaded
 * conversation's live surface state. Visibility follows the loaded
 * conversation's turn-or-resting trust. Returns an empty list when no
 * trusted live conversation context is available.
 */
export async function listConversationSurfaces(
  conversationId: string,
): Promise<ConversationSurfaceSnapshot[]> {
  const { listConversationSurfaceSnapshots } = await import(
    "../daemon/conversation-surface-snapshots.js"
  );
  return listConversationSurfaceSnapshots(conversationId);
}
