/**
 * Consolidates side effects that fire when `activeConversationId` changes:
 *
 * - Dismiss any pending interactive prompt (question, confirmation, etc.)
 * - Reset subagent tracking state
 * - Auto-fetch detail for subagents reconstructed from conversation history
 *   (entries with a `conversationId` but no events yet)
 *
 * These effects are orthogonal to the main orchestration flow (SSE, send
 * message, reconciliation) and only depend on `activeConversationId` plus
 * stable store references.
 */

import { useEffect } from "react";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";

export function useConversationChangeEffects(
  assistantId: string | null,
  activeConversationId: string | null,
): void {
  // Dismiss any pending question / confirmation / secret prompt
  useEffect(() => {
    useInteractionStore.getState().dismissQuestion();
  }, [activeConversationId]);

  // Reset subagent tracking state
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
