import { useQuery } from "@tanstack/react-query";

import { getAssistantHealthz } from "@/assistant/api";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type AssistantCapability = keyof NonNullable<
  HealthzGetResponse["capabilities"]
>;

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
export function useAssistantCapabilityQuery(capability: AssistantCapability) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // Platform health reads need the organization header hydrated after auth.
  const isOrgReady = useIsOrgReady();
  return useQuery({
    queryKey: ["assistant-capability", capability, assistantId],
    enabled: assistantId != null && isOrgReady,
    queryFn: async () => {
      if (!assistantId) {
        return false;
      }
      const result = await getAssistantHealthz(assistantId);
      if (!result.ok) {
        throw new Error("Unable to load assistant capabilities", {
          cause: result.error,
        });
      }
      return result.data.capabilities?.[capability] === true;
    },
    retry: false,
    // Capabilities are static per daemon process; they only change across a
    // restart/upgrade, so a long stale window avoids re-pinging healthz on
    // every mount.
    staleTime: 60_000,
  });
}

export function useAssistantCapability(
  capability: AssistantCapability,
): boolean {
  const query = useAssistantCapabilityQuery(capability);
  return !query.isError && query.data === true;
}
