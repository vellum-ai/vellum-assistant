import { useCallback, useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AssistantChannelState } from "@/domains/contacts/types";
import { isSetupChannelId } from "@/domains/contacts/types";
import {
  fetchChannelPolicies,
  setChannelPolicy,
} from "@/lib/channel-admission-policy/api";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { toastOnError } from "@/utils/mutation-error";

type ChannelKey = AssistantChannelState["key"];

export interface ChannelTrustFloors {
  /** Floor per inline channel, or `undefined` when the feature is off. */
  policies?: Partial<Record<ChannelKey, AdmissionPolicy>>;
  /** Channel whose floor write is in flight, or `null`. */
  savingKey: ChannelKey | null;
  /** True until the floors have loaded at least once. */
  isLoading: boolean;
  /** True when the floors failed to load. */
  isError: boolean;
  /** Persist a floor, or `undefined` when the feature is off. */
  onChange?: (channelKey: ChannelKey, policy: AdmissionPolicy) => void;
}

/**
 * Per-channel admission floor (trust floor) wiring for the assistant's
 * channel list (the Channels tab and the Contacts assistant detail). Reads
 * the `channelTrustFloors` flag itself; when off it returns no policies and
 * no `onChange`, which hides the inline control entirely.
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
      if (isSetupChannelId(p.channelType)) {
        map[p.channelType] = p.policy;
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
    return {
      policies: undefined,
      savingKey: null,
      isLoading: false,
      isError: false,
      onChange: undefined,
    };
  }

  return {
    policies,
    savingKey: mutation.isPending
      ? mutation.variables?.channelKey ?? null
      : null,
    // `isPending` stays true until the first successful fetch, so callers can
    // hold the control disabled instead of flashing the default floor over a
    // channel that actually has a stored non-default (e.g. `no_one`) policy.
    isLoading: query.isPending,
    isError: query.isError,
    onChange,
  };
}
