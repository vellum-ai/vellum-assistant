import { useQuery } from "@tanstack/react-query";

import { configGet, conversationsByIdGet } from "@/generated/daemon/sdk.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

/**
 * Resolves the (provider, model) pair currently in effect for a chat
 * conversation by reading the assistant's LLM config and the optional
 * per-conversation profile override.
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
 * Stable query key for the active-profile-model lookup. Callers that mutate
 * the underlying LLM config (e.g. `ComposerSettingsMenu` when the user
 * switches profile, or `manage-profiles-modal` when a profile's
 * provider/model is edited) use this to invalidate the cache and refresh
 * dependent UI without waiting for the staleTime to elapse.
 */
export function activeProfileModelQueryKey(
  assistantId: string | null,
  conversationId: string | null | undefined,
): readonly unknown[] {
  return ["active-profile-model", assistantId, conversationId ?? null];
}

export function useActiveProfileModel(
  assistantId: string | null,
  conversationId: string | undefined,
): ActiveProfileModel | null {
  const { data } = useQuery({
    enabled: !!assistantId,
    queryKey: activeProfileModelQueryKey(assistantId, conversationId),
    queryFn: async (): Promise<ActiveProfileModel | null> => {
      if (!assistantId) return null;
      const [configResult, convResult] = await Promise.allSettled([
        configGet({
          path: { assistant_id: assistantId },
          throwOnError: false,
        }),
        conversationId
          ? conversationsByIdGet({
              path: { assistant_id: assistantId, id: conversationId },
              throwOnError: false,
            })
          : Promise.resolve(null),
      ]);

      if (configResult.status !== "fulfilled" || !configResult.value?.data) {
        return null;
      }
      const llm = configResult.value.data.llm;
      const profiles = llm?.profiles ?? {};
      const globalActive = llm?.activeProfile ?? null;

      let effective: string | null = globalActive;
      if (convResult?.status === "fulfilled" && convResult.value !== null) {
        const override =
          convResult.value.data?.conversation.inferenceProfile ?? null;
        if (override !== null) {
          effective = override;
        }
      }

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
    },
    staleTime: 30_000,
  });

  return data ?? null;
}
