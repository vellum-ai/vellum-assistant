/**
 * Hydrate the page-level context-window-usage map from localStorage when the
 * assistant comes online, and surface the active conversation's usage to the
 * caller.
 *
 * The map is the source of truth across conversation switches: the switch
 * effect reads from it to restore the indicator when re-entering a
 * conversation, and stream events write to it as new usage data arrives.
 * This hook only handles the initial hydration — the merge is keyed by
 * `assistantId` so it runs at most once per assistant per page lifetime.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";

import { loadContextWindowUsageMap } from "@/domains/chat/utils/context-window-storage.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";

export interface UseContextWindowUsageHydrationParams {
  assistantId: string | null;
  activeConversationId: string | null;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
}

export function useContextWindowUsageHydration({
  assistantId,
  activeConversationId,
  contextWindowUsageByConversationRef,
  setContextWindowUsage,
}: UseContextWindowUsageHydrationParams): void {
  const hydratedAssistantIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!assistantId) return;
    if (hydratedAssistantIdRef.current === assistantId) return;
    hydratedAssistantIdRef.current = assistantId;
    const stored = loadContextWindowUsageMap(assistantId);
    if (stored.size === 0) return;
    const merged = new Map(contextWindowUsageByConversationRef.current);
    for (const [key, value] of stored) {
      if (!merged.has(key)) {
        merged.set(key, value);
      }
    }
    contextWindowUsageByConversationRef.current = merged;
    if (activeConversationId) {
      const cached = merged.get(activeConversationId);
      if (cached) {
        setContextWindowUsage(cached);
      }
    }
  }, [
    assistantId,
    activeConversationId,
    contextWindowUsageByConversationRef,
    setContextWindowUsage,
  ]);
}
