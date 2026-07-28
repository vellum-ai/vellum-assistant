import { useQuery } from "@tanstack/react-query";

import { getAssistantHealthz } from "@/assistant/api";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type AssistantCapability = keyof NonNullable<HealthzGetResponse["capabilities"]>;

/**
 * Whether the active assistant advertises a healthz `capabilities` flag.
 *
 * Capability flags gate features that ship behind a new daemon endpoint
 * where a version gate can't work: released daemons without the endpoint
 * share a base version with source-built daemons that have it, so semver
 * can't separate the two. Daemons that omit the capability (including all
 * older releases) simply never light the feature up.
 *
 * Reads the raw selection store (not `useActiveAssistantId()`) so callers
 * on surfaces that render across pre-active lifecycle states — the chat
 * route — don't trip the gated accessor's throw.
 */
export function useAssistantCapability(
  capability: AssistantCapability,
): boolean {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { data: supported = false } = useQuery({
    queryKey: ["assistant-capability", capability, assistantId],
    enabled: assistantId != null,
    queryFn: async () => {
      if (!assistantId) {
        return false;
      }
      const result = await getAssistantHealthz(assistantId);
      return result.ok && result.data.capabilities?.[capability] === true;
    },
    retry: false,
    // Capabilities are static per daemon process; they only change across a
    // restart/upgrade, so a long stale window avoids re-pinging healthz on
    // every mount.
    staleTime: 60_000,
  });
  return supported;
}
