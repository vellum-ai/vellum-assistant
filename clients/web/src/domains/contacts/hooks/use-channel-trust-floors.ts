import { useCallback, useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AssistantChannelState } from "@/domains/contacts/types";
import {
  fetchChannelPolicies,
  setChannelPolicy,
} from "@/lib/channel-admission-policy/api";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { toastOnError } from "@/utils/mutation-error";

type ChannelKey = AssistantChannelState["key"];

/**
 * slack/telegram/phone are the only channels with an inline trust-floor home in
 * the Contacts → Channels list. Other channel types the gateway returns (e.g.
 * email) are intentionally not surfaced here.
 */
const INLINE_FLOOR_CHANNELS = new Set<string>(["slack", "telegram", "phone"]);

export interface ChannelTrustFloors {
  /** Floor per inline channel, or `undefined` when the feature is off. */
  policies?: Partial<Record<ChannelKey, AdmissionPolicy>>;
  /** Channel whose floor write is in flight, or `null`. */
  savingKey: ChannelKey | null;
  /** Persist a floor, or `undefined` when the feature is off. */
  onChange?: (channelKey: ChannelKey, policy: AdmissionPolicy) => void;
}

/**
 * Per-channel admission floor (trust floor) wiring for the Contacts → Channels
 * list. Reads the `channelTrustFloors` flag itself; when off it returns no
 * policies and no `onChange`, which hides the inline control entirely.
 */
export function useChannelTrustFloors(assistantId: string): ChannelTrustFloors {
  const queryClient = useQueryClient();
  const enabled = useAssistantFeatureFlagStore.use.channelTrustFloors();

  const queryKey = useMemo(
    () => ["channel-admission-policy", assistantId] as const,
    [assistantId],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => fetchChannelPolicies(assistantId),
    enabled,
  });

  const policies = useMemo(() => {
    const map: Partial<Record<ChannelKey, AdmissionPolicy>> = {};
    for (const p of query.data ?? []) {
      if (INLINE_FLOOR_CHANNELS.has(p.channelType)) {
        map[p.channelType as ChannelKey] = p.policy;
      }
    }
    return map;
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: ({
      channelKey,
      policy,
    }: {
      channelKey: ChannelKey;
      policy: AdmissionPolicy;
    }) => setChannelPolicy(assistantId, channelKey, policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: toastOnError("Failed to save channel policy"),
  });

  const onChange = useCallback(
    (channelKey: ChannelKey, policy: AdmissionPolicy) => {
      mutation.mutate({ channelKey, policy });
    },
    [mutation],
  );

  if (!enabled) {
    return { policies: undefined, savingKey: null, onChange: undefined };
  }

  return {
    policies,
    savingKey: mutation.isPending
      ? mutation.variables?.channelKey ?? null
      : null,
    onChange,
  };
}
