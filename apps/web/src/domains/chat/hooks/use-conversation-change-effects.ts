/**
 * Consolidates side effects that fire when `activeConversationId` changes:
 *
 * - Reset subagent tracking state (needed for URL-navigation paths that
 *   bypass the `switchConversation` / `startNewConversation` wrappers)
 * - Auto-fetch detail for subagents reconstructed from conversation history
 *   (entries with a `conversationId` but no events yet)
 *
 * Note: interaction store cleanup (`dismissQuestion`, `resetAll`) is NOT
 * handled here — `switchToConversation()` in `chat-session-store` already
 * calls `useInteractionStore.getState().resetAll()` on every conversation
 * switch, covering both wrapper-initiated and URL-navigation paths.
 */

import { useEffect } from "react";

import { useSubagentStore } from "@/domains/chat/subagent-store";

export function useConversationChangeEffects(
  assistantId: string | null,
  activeConversationId: string | null,
): void {
  // Reset subagent tracking on conversation change. The wrapper-initiated
  // path (`switchConversation` / `startNewConversation`) also resets eagerly
  // to prevent stale UI flashes — the double-reset is harmless (idempotent).
  // This effect catches the URL-navigation path where wrappers don't run.
  useEffect(() => {
    useSubagentStore.getState().reset();
  }, [activeConversationId]);

  // Stable signal: changes only when the set of subagent IDs that need a
  // detail fetch changes (entry appears with conversationId + no events,
  // or an entry receives events). Immune to loadDetail calls that update
  // status/objective without changing events, preventing retrigger loops.
  const unfetchedSubagentKey = useSubagentStore((s) => {
    const ids: string[] = [];
    for (const entry of Object.values(s.byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        ids.push(entry.subagentId);
      }
    }
    return ids.sort().join(',');
  });

  // Auto-fetch details for subagents reconstructed from history
  useEffect(() => {
    if (!assistantId || !unfetchedSubagentKey) return;
    for (const entry of Object.values(useSubagentStore.getState().byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        void useSubagentStore.getState().fetchDetailIfNeeded(assistantId, entry.subagentId);
      }
    }
  }, [assistantId, unfetchedSubagentKey]);
}
