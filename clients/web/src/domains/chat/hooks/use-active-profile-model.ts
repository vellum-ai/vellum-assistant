import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  configGetOptions,
  conversationsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

/**
 * Resolves the (provider, model) pair currently in effect for a chat
 * conversation by reading the assistant's LLM config and the optional
 * per-conversation profile override.
 *
 * Both queries share their respective TanStack Query cache entries with
 * the rest of the app (settings domain, composer settings menu, etc.) so
 * invalidating the config or conversation cache from any consumer also
 * refreshes this hook's derivation.
 *
 * Used by the chat composer to gate behaviors that depend on model
 * capabilities (e.g. image attachments require a vision-capable model).
 * Returns `null` when the data isn't loaded yet or the active profile
 * doesn't declare a provider/model.
 *
 * `supportsVision` is resolved server-side by the daemon from its model
 * catalog and embedded on each profile entry in the config response.
 */
export interface ActiveProfileModel {
  provider: string;
  model: string;
  supportsVision?: boolean;
}

type ProfileEntry = NonNullable<
  NonNullable<ConfigGetResponse["llm"]>["profiles"]
>[string];

/**
 * @param pendingProfile Profile stashed in the composer for a conversation
 *   whose row hasn't loaded yet (a draft, or one opened by URL mid-load) — see
 *   `pendingDraftProfiles` in `conversation-store`. It's the effective profile
 *   until the row materializes, so capability gating (e.g. image attachments)
 *   should reflect it. A loaded per-conversation override still wins.
 */
export function useActiveProfileModel(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): ActiveProfileModel | null {
  return useActiveProfileModelState(assistantId, conversationId, pendingProfile)
    .model;
}

/** What `useActiveProfileModelState` reports about the effective profile. */
export interface ActiveProfileModelState {
  /** The (provider, model) pair in effect, null while none resolves. */
  model: ActiveProfileModel | null;
  /**
   * Whether the reads behind `model` have settled. A null `model` under a true
   * `resolved` is the answer (no profile declares a provider/model); under a
   * false one it is a query still in flight, which a caller gating a
   * capability on the model holds for rather than guessing at.
   */
  resolved: boolean;
}

/**
 * `useActiveProfileModel` plus the signal that tells a still-loading read from
 * a settled absence.
 *
 * @param pendingProfile As on `useActiveProfileModel`.
 */
export function useActiveProfileModelState(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): ActiveProfileModelState {
  const isOrgReady = useIsOrgReady();
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId && isOrgReady,
    staleTime: 30_000,
  });

  const conversationEnabled = !!assistantId && !!conversationId && isOrgReady;
  const { data: convData, status: convStatus } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: conversationEnabled,
  });

  // A disabled query stays pending at an idle fetch, so only an enabled one
  // reports anything by its status, and only its row answers: a read that
  // failed says nothing about the override the row may carry, so the target
  // stays unresolved rather than passing for the global profile. A caller
  // with no row to read (a live draft) passes no id and resolves on the
  // config alone.
  const resolved =
    !!config && (!conversationEnabled || convStatus === "success");

  const model = useMemo(() => {
    if (!config) {
      return null;
    }
    const llm = config.llm;
    const profiles = llm?.profiles ?? {};
    const globalActive = llm?.activeProfile ?? null;

    const convOverride = convData?.conversation.inferenceProfile ?? null;
    const effective = convOverride ?? pendingProfile ?? globalActive;

    if (!effective) {
      return null;
    }
    const entry: ProfileEntry | undefined = profiles[effective];
    if (!entry?.provider || !entry.model) {
      return null;
    }
    return {
      provider: entry.provider,
      model: entry.model,
      ...(typeof entry.supportsVision === "boolean"
        ? { supportsVision: entry.supportsVision }
        : {}),
    };
  }, [config, convData, pendingProfile]);

  return useMemo(() => ({ model, resolved }), [model, resolved]);
}
