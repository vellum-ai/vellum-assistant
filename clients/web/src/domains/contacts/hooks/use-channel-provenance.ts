import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import type { CascadeProvenance } from "@/domains/contacts/components/provenance-pill";
import { isSetupChannelId, type SetupChannelId } from "@/domains/contacts/types";
import { fetchChannelPolicies } from "@/lib/channel-admission-policy/api";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

export type ChannelProvenanceMap = Partial<
  Record<SetupChannelId, CascadeProvenance>
>;

/**
 * Per-channel cascade provenance for the contact detail's channel rows —
 * whether each setup channel's admission floor comes from the global default
 * (no stored row, `updatedAt` null) or a channel-level default set on the
 * Channels tab. Reads the `channelTrustFloors` flag itself; when off it
 * returns `undefined`, which hides the provenance pill entirely.
 *
 * Shares its query key with `useChannelTrustFloors` so both surfaces read
 * one cache entry.
 */
export function useChannelProvenance(
  assistantId: string,
): ChannelProvenanceMap | undefined {
  const enabled = useAssistantFeatureFlagStore.use.channelTrustFloors();

  const query = useQuery({
    queryKey: ["channel-admission-policy", assistantId] as const,
    queryFn: () => fetchChannelPolicies(assistantId),
    enabled,
  });

  return useMemo(() => {
    if (!enabled || !query.data) {
      return undefined;
    }
    const map: ChannelProvenanceMap = {};
    for (const policy of query.data) {
      if (!isSetupChannelId(policy.channelType)) {
        continue;
      }
      map[policy.channelType] =
        policy.updatedAt != null
          ? { source: "channel-default", channel: policy.channelType }
          : { source: "global-default" };
    }
    return map;
  }, [enabled, query.data]);
}
