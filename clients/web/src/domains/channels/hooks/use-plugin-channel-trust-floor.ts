/**
 * The admission floor for plugin-brought channels.
 *
 * Separate from {@link import("./use-channel-trust-floors.js").useChannelTrustFloors}
 * because that one is keyed by `SetupChannelId` — the built-in adapters, each
 * with its own row and its own panel. Every plugin channel shares the single
 * `plugin` row instead, since the gateway has one channel id covering them all
 * (`packages/service-contracts/src/channels.ts`), so there is no per-plugin key
 * to hang it off and the list hook drops the row rather than mis-key it.
 *
 * It reads through the same generated query as the list hook, so both share one
 * cache entry and a floor changed here is reflected there without a refetch.
 *
 * This exists because the floor seeds at `guardian_only`, which is stricter
 * than any other inbound channel and strict enough that a fresh install rejects
 * its first message. Making that an explicit choice — the wording the panel
 * uses — requires somewhere to make it, and the plugin panel is the only
 * surface a plugin channel has.
 */

import { useCallback, useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  assistantChannelAdmissionPolicyListOptions,
  assistantChannelAdmissionPolicyListQueryKey,
} from "@/generated/gateway/@tanstack/react-query.gen";
import {
  setChannelPolicy,
  toChannelPolicyViews,
} from "@/lib/channel-admission-policy/api";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import { useSupportsChannelTrustFloors } from "@/lib/backwards-compat/channel-trust-floors";
import { toastOnError } from "@/utils/mutation-error";

/** The one channel id every plugin channel's inbound is admitted under. */
const PLUGIN_CHANNEL_TYPE = "plugin";

export interface PluginChannelTrustFloor {
  /** The stored floor, or `undefined` while loading or when unsupported. */
  policy?: AdmissionPolicy;
  /** True until the floor has loaded at least once. */
  isLoading: boolean;
  /** True when the floor failed to load. */
  isError: boolean;
  /** True while a write is in flight. */
  isSaving: boolean;
  /**
   * Persist a floor, or `undefined` when this gateway has no floors at all.
   * Absent means the control renders nowhere rather than offering a setting
   * the gateway would refuse.
   */
  onChange?: (policy: AdmissionPolicy) => void;
}

export function usePluginChannelTrustFloor(
  assistantId: string,
): PluginChannelTrustFloor {
  const queryClient = useQueryClient();
  const enabled = useSupportsChannelTrustFloors();

  const pathOptions = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const queryKey = useMemo(
    () => assistantChannelAdmissionPolicyListQueryKey(pathOptions),
    [pathOptions],
  );

  const query = useQuery({
    ...assistantChannelAdmissionPolicyListOptions(pathOptions),
    enabled: enabled && Boolean(assistantId),
    select: toChannelPolicyViews,
  });

  const mutation = useMutation({
    mutationFn: (policy: AdmissionPolicy) =>
      setChannelPolicy(assistantId, PLUGIN_CHANNEL_TYPE, policy),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: toastOnError("Failed to save channel policy"),
  });

  const onChange = useCallback(
    (policy: AdmissionPolicy) => {
      mutation.mutate(policy);
    },
    [mutation],
  );

  if (!enabled) {
    return {
      policy: undefined,
      isLoading: false,
      isError: false,
      isSaving: false,
      onChange: undefined,
    };
  }

  return {
    policy: query.data?.find((p) => p.channelType === PLUGIN_CHANNEL_TYPE)
      ?.policy,
    // `isPending` stays true until the first successful fetch, so the control
    // can hold rather than flash the default over a stored non-default floor
    // and let it be overwritten.
    isLoading: query.isPending,
    isError: query.isError,
    isSaving: mutation.isPending,
    onChange,
  };
}
