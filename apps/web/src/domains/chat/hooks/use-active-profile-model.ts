import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
    configGetOptions,
    conversationsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

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

export function useActiveProfileModel(
  assistantId: string | null,
  conversationId: string | undefined,
): ActiveProfileModel | null {
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  return useMemo(() => {
    if (!config) return null;
    const llm = config.llm;
    const profiles = llm?.profiles ?? {};
    const globalActive = llm?.activeProfile ?? null;

    const convOverride =
      convData?.conversation.inferenceProfile ?? null;
    const effective = convOverride ?? globalActive;

    if (!effective) return null;
    const entry: ProfileEntry | undefined = profiles[effective];
    if (!entry?.provider || !entry.model) return null;
    return {
      provider: entry.provider,
      model: entry.model,
      ...(typeof entry.supportsVision === "boolean"
        ? { supportsVision: entry.supportsVision }
        : {}),
    };
  }, [config, convData]);
}
