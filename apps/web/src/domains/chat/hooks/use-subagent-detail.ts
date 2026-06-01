/**
 * Fetches and hydrates subagent execution detail from the daemon.
 *
 * Owns the detail-fetch callback, the per-conversation deduplication ref,
 * and the auto-fetch effect that populates detail for subagents
 * reconstructed from conversation history.
 */

import { useCallback, useEffect, useRef } from "react";

import { useSubagentStore, type SubagentTimelineEvent } from "@/domains/chat/subagent-store";
import { fetchSubagentDetail } from "@/utils/fetch-subagent-detail";

interface UseSubagentDetailParams {
  assistantId: string | null;
  activeConversationId: string | null;
}

interface UseSubagentDetailResult {
  handleRequestSubagentDetail: (subagentId: string) => Promise<void>;
}

export function useSubagentDetail({
  assistantId,
  activeConversationId,
}: UseSubagentDetailParams): UseSubagentDetailResult {
  const subagentById = useSubagentStore.use.byId();

  const handleRequestSubagentDetail = useCallback(
    async (subagentId: string) => {
      if (!assistantId) return;
      const entry = useSubagentStore.getState().byId[subagentId];
      if (!entry?.conversationId) return;

      const detail = await fetchSubagentDetail(assistantId, subagentId, entry.conversationId);
      if (!detail) return;

      let eventCounter = 0;
      const events: SubagentTimelineEvent[] = [];

      for (const evt of detail.events) {
        let type: SubagentTimelineEvent["type"];

        switch (evt.type) {
          case "text":
          case "assistant_text_delta":
            type = "text";
            break;
          case "tool_use":
          case "tool_use_start":
            type = "tool_call";
            break;
          case "tool_result":
            type = "tool_result";
            break;
          case "error":
            type = "error";
            break;
          default:
            continue;
        }

        const content = evt.content;

        if (type === "text" && content === "") continue;

        // Coalesce consecutive text events
        const prev = events[events.length - 1];
        if (type === "text" && prev && prev.type === "text") {
          prev.content += "\n\n" + content;
          continue;
        }

        events.push({
          id: `detail-${++eventCounter}`,
          type,
          content,
          toolName: evt.toolName,
          isError: evt.isError,
          timestamp: Date.now(),
        });
      }

      useSubagentStore.getState().loadDetail({
        subagentId,
        status: detail.status,
        objective: detail.objective,
        inputTokens: detail.usage?.inputTokens,
        outputTokens: detail.usage?.outputTokens,
        totalCost: detail.usage?.estimatedCost,
        events,
      });
    },
    [assistantId],
  );

  // Auto-fetch details for subagents reconstructed from history (mirrors
  // macOS behavior of calling the detail endpoint on reload to get correct
  // status, metrics, and events). Keyed by subagentId → spawnedAt at fetch
  // time so that store rebuilds (e.g. background TanStack Query refetches
  // that reset + respawn entries) produce a new spawnedAt and allow
  // re-fetching.
  const fetchedSubagentsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    fetchedSubagentsRef.current.clear();
  }, [activeConversationId]);

  useEffect(() => {
    if (!assistantId) return;
    const entries = Object.values(subagentById);
    for (const entry of entries) {
      if (entry.conversationId && entry.events.length === 0) {
        const fetchedAt = fetchedSubagentsRef.current.get(entry.subagentId);
        if (fetchedAt !== undefined && fetchedAt >= entry.spawnedAt) continue;
        fetchedSubagentsRef.current.set(entry.subagentId, entry.spawnedAt);
        handleRequestSubagentDetail(entry.subagentId);
      }
    }
  }, [assistantId, subagentById, handleRequestSubagentDetail]);

  return { handleRequestSubagentDetail };
}
