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

import { useEffect, useLayoutEffect } from "react";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";

export function useConversationChangeEffects(
  assistantId: string | null,
  activeConversationId: string | null,
): void {
  // Reset subagent + workflow tracking on conversation change. Runs as a
  // layout effect so it completes before any freshly-mounted card's passive
  // hydration effect: every `useLayoutEffect` in the tree fires before any
  // `useEffect`, so this reset's `generation` bump lands before a child card
  // calls `hydrateRunIfNeeded`. As a passive effect it would run after the
  // child (effects fire children-first), letting a card capture the pre-reset
  // `generation`; the reset would then bump it and the in-flight hydration
  // would discard its own result as stale — leaving the card blank with no
  // retry. The wrapper-initiated path (`switchConversation` /
  // `startNewConversation`) also resets eagerly; the double-reset is idempotent.
  // This effect catches the URL-navigation path where wrappers don't run.
  useLayoutEffect(() => {
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
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
