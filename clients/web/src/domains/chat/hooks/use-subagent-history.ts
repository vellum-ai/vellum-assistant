/**
 * Keeps a subagent's canonical history loaded while a surface reads it.
 *
 * The history is fetched when the surface mounts and again whenever it goes
 * missing: after a failed fetch, or after a stream gap dropped it
 * (`invalidateHistories`). The returned function retries on demand, for a
 * surface that needs the history now, such as a tool pill clicked while it is
 * missing.
 */

import { useCallback, useEffect } from "react";

import {
  useSubagentStore,
  type SubagentEntry,
} from "@/domains/chat/subagent-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function useSubagentHistory(
  entry: Pick<SubagentEntry, "subagentId" | "conversationId" | "history">,
  assistantId?: string | null,
): () => Promise<void> {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const resolvedAssistantId = assistantId ?? activeAssistantId;
  const { subagentId, conversationId } = entry;
  const historyMissing = entry.history === null;

  useEffect(() => {
    // A child conversation learned after mount (from the detail response or an
    // inner event) is what makes the history fetchable, so it re-runs this.
    if (historyMissing && resolvedAssistantId && conversationId) {
      void useSubagentStore
        .getState()
        .loadHistoryIfNeeded(resolvedAssistantId, subagentId);
    }
  }, [historyMissing, resolvedAssistantId, subagentId, conversationId]);

  return useCallback(
    () =>
      resolvedAssistantId
        ? useSubagentStore
            .getState()
            .loadHistoryIfNeeded(resolvedAssistantId, subagentId)
        : Promise.resolve(),
    [resolvedAssistantId, subagentId],
  );
}
