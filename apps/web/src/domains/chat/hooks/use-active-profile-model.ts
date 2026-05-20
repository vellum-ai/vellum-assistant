import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";

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
 * `supportsVision` mirrors the daemon catalog's per-model flag and is
 * surfaced here at runtime so the platform repo doesn't have to ship a
 * duplicated copy of that data. The daemon resolves the active model
 * against its catalog and either embeds the flag on the profile entry
 * (`profile.supportsVision`) or exposes a sibling `models` map; both
 * shapes are handled below. When neither is present the value is
 * `undefined` and callers fall back to a permissive default.
 */
export interface ActiveProfileModel {
  provider: string;
  model: string;
  supportsVision?: boolean;
}

interface ProfileEntry {
  provider?: string | null;
  model?: string | null;
  /**
   * Optional vision-capability flag resolved by the daemon from its model
   * catalog. The daemon may serve this directly on the profile entry or via
   * a sibling catalog map — see `resolveSupportsVision` below.
   */
  supportsVision?: boolean | null;
}

interface CatalogModelEntry {
  id?: string;
  supportsVision?: boolean | null;
}

interface CatalogProviderEntry {
  id?: string;
  models?: readonly CatalogModelEntry[];
}

/**
 * Walk the daemon config response looking for `supportsVision` for the
 * resolved (provider, model). Tolerates two shapes so this works both today
 * (when the daemon embeds the flag on the profile entry) and after a future
 * daemon change that surfaces the full catalog map:
 *
 *   1. `data.llm.profiles[name].supportsVision` — daemon resolved it server-side.
 *   2. `data.llm.providers[].models[]` — daemon embedded its catalog inline.
 *
 * Returns `undefined` when the daemon hasn't surfaced the data — callers
 * should fall back to a permissive default.
 */
function resolveSupportsVision(
  llm: Record<string, unknown>,
  profileEntry: ProfileEntry,
  provider: string,
  model: string,
): boolean | undefined {
  if (typeof profileEntry.supportsVision === "boolean") {
    return profileEntry.supportsVision;
  }
  const providers = llm.providers as readonly CatalogProviderEntry[] | undefined;
  if (!Array.isArray(providers)) return undefined;
  const providerEntry = providers.find(
    (p: CatalogProviderEntry) => p?.id === provider,
  );
  const modelEntry = providerEntry?.models?.find(
    (m: CatalogModelEntry) => m?.id === model,
  );
  if (typeof modelEntry?.supportsVision === "boolean") {
    return modelEntry.supportsVision;
  }
  return undefined;
}

/**
 * Stable query key for the active-profile-model lookup. Exported so callers
 * that mutate the underlying LLM config (e.g. `ComposerSettingsMenu` when the
 * user switches profile, or `manage-profiles-modal` when a profile's
 * provider/model is edited) can invalidate this cache and refresh dependent
 * UI without waiting for the staleTime to elapse.
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
        client.get<Record<string, unknown>, unknown>({
          url: `/v1/assistants/{assistant_id}/config`,
          path: { assistant_id: assistantId },
          throwOnError: false,
        }),
        conversationId
          ? client.get<Record<string, unknown>, unknown>({
              url: `/v1/assistants/{assistant_id}/conversations/{conversation_id}`,
              path: {
                assistant_id: assistantId,
                conversation_id: conversationId,
              },
              throwOnError: false,
            })
          : Promise.resolve(null),
      ]);

      if (configResult.status !== "fulfilled" || !configResult.value?.data) {
        return null;
      }
      const llm =
        (configResult.value.data as { llm?: Record<string, unknown> }).llm ?? {};
      const profiles =
        (llm.profiles as Record<string, ProfileEntry> | undefined) ?? {};
      const globalActive =
        (llm.activeProfile as string | null | undefined) ?? null;

      let effective: string | null = globalActive;
      if (
        convResult?.status === "fulfilled" &&
        convResult.value !== null &&
        convResult.value?.data
      ) {
        const convData = convResult.value.data as Record<string, unknown>;
        const conv =
          (convData.conversation as Record<string, unknown> | undefined) ??
          convData;
        const override =
          typeof conv.inferenceProfile === "string"
            ? conv.inferenceProfile
            : null;
        if (override !== null) effective = override;
      }

      if (!effective) return null;
      const entry = profiles[effective];
      if (!entry?.provider || !entry.model) return null;
      const supportsVision = resolveSupportsVision(
        llm,
        entry,
        entry.provider,
        entry.model,
      );
      return {
        provider: entry.provider,
        model: entry.model,
        ...(supportsVision !== undefined ? { supportsVision } : {}),
      };
    },
    staleTime: 30_000,
  });

  return data ?? null;
}
