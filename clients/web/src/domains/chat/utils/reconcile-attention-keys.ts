import type { QueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/stores/conversation-store";
import { getConversations } from "@/utils/conversation-cache";
import { listConversationIdsWithPendingInteractions } from "@/domains/chat/api/interactions";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";

/**
 * Reveal lazy sidebar sections (Background / Scheduled) when a pending
 * interaction belongs to a conversation not yet loaded.
 */
function revealLazySectionsIfPendingUnloaded(
  pendingKeys: ReadonlySet<string>,
  loadedConversationIds: ReadonlySet<string>,
): void {
  for (const key of pendingKeys) {
    if (!loadedConversationIds.has(key)) {
      const store = useSidebarCollapseStore.getState();
      store.activateBackground();
      store.activateScheduled();
      return;
    }
  }
}

/**
 * Reconcile attention and processing keys against the daemon's pending
 * interactions list. Used by both the post-reconnect sweep and the
 * initial mount sweep.
 *
 * Pure async function — no React primitives. Reads and writes Zustand
 * stores directly.
 *
 * @param opts.pruneStale  When true, removes attention/processing keys
 *   that are no longer pending. The reconnect sweep enables this; the
 *   initial sweep (which starts from an empty set) does not.
 */
export async function reconcileAttentionKeys(
  assistantId: string,
  queryClient: QueryClient,
  opts: { pruneStale: boolean } = { pruneStale: false },
): Promise<void> {
  let pendingKeys: Set<string>;
  try {
    pendingKeys = await listConversationIdsWithPendingInteractions(assistantId);
  } catch {
    return; // Best-effort — SSE events will catch subsequent transitions.
  }

  const currentConversations = getConversations(queryClient, assistantId);
  const loadedIds = new Set(currentConversations.map((c) => c.conversationId));

  revealLazySectionsIfPendingUnloaded(pendingKeys, loadedIds);

  // Read activeConversationId AFTER the await so we use the current
  // value, not one captured before the network call.
  const state = useConversationStore.getState();
  const activeConversationId = state.activeConversationId;

  if (opts.pruneStale) {
    for (const key of state.attentionConversationIds) {
      if (key === activeConversationId) continue;
      if (!pendingKeys.has(key)) state.removeAttentionConversationId(key);
    }
    for (const key of state.processingConversationIds) {
      if (key === activeConversationId) continue;
      if (pendingKeys.has(key)) {
        state.addAttentionConversationId(key);
        state.removeProcessingConversationId(key);
      }
    }
  }

  for (const key of pendingKeys) {
    if (key === activeConversationId) continue;
    if (!state.attentionConversationIds.has(key) && !state.processingConversationIds.has(key)) {
      state.addAttentionConversationId(key);
    }
  }
}
