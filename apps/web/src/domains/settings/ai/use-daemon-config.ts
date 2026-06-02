/**
 * Shared TanStack Query hook for the daemon config endpoint.
 *
 * Every service card (Web Search, Image Generation, Language Model) and the
 * AI page shell call this hook independently. TanStack Query deduplicates
 * identical queries — zero redundant network calls despite multiple consumers.
 *
 * Uses the generated `configGetQueryKey` so that SSE-driven invalidation
 * (via `use-assistant-resource-sync`) and component-level invalidation all
 * target the same cache entry.
 *
 * The query cache is the single source of truth for daemon config state.
 * Components derive profiles, profileOrder, activeProfile, and callSites
 * directly from the cache — no `useState` copies. Mutations use
 * `useDaemonConfigMutation` which automatically invalidates the cache
 * on settle, propagating updates to all consumers.
 */

import { useCallback, useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { configGet, configPatch, secretsPost, modelImagegenPut } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import { assertProvisionSuccess, buildOrderedProfiles } from "@/domains/settings/ai/ai-utils";
import type { CallSiteOverrideDraft, DaemonConfig, ProfileEntry } from "@/domains/settings/ai/ai-types";

/**
 * Hook providing the daemon config query and common mutation helpers.
 *
 * Each consumer gets the same TanStack Query cache entry (queries are
 * deduplicated by key). Cards that only read config pay no extra cost.
 *
 * Typed slices (profiles, profileOrder, etc.) are derived via `useMemo`
 * from the raw config — no `useState` copies, no hydration effects.
 */
export function useDaemonConfig() {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;
  const assistantHandle = assistantList?.results?.[0]?.handle;

  const configQuery = useQuery({
    queryKey: assistantDaemonConfigQueryKey(assistantId),
    queryFn: async () => {
      const { data } = await configGet({
        path: { assistant_id: assistantId! },
        throwOnError: true,
      });
      // The daemon config endpoint's OpenAPI spec doesn't define a typed
      // response body yet — the generated type is `unknown`. This cast is
      // the single point where we bridge to the hand-written DaemonConfig
      // interface until the spec is updated.
      return data as DaemonConfig;
    },
    enabled: !!assistantId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const config = configQuery.data;

  // Typed slices derived from the query cache — stable references when
  // the underlying data hasn't changed.
  const profiles: Record<string, ProfileEntry> = useMemo(
    () => config?.llm?.profiles ?? {},
    [config?.llm?.profiles],
  );
  const profileOrder: string[] = useMemo(
    () => config?.llm?.profileOrder ?? [],
    [config?.llm?.profileOrder],
  );
  const activeProfile: string | null = useMemo(
    () => config?.llm?.activeProfile ?? null,
    [config?.llm?.activeProfile],
  );
  const callSites: Record<string, CallSiteOverrideDraft | null | undefined> = useMemo(
    () => config?.llm?.callSites ?? {},
    [config?.llm?.callSites],
  );
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );

  const invalidateConfig = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: assistantDaemonConfigQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  const resolveAssistantId = useCallback(async (): Promise<string | null> => {
    if (assistantId) return assistantId;
    const list = await queryClient.fetchQuery(assistantsListOptions());
    return list.results?.[0]?.id ?? null;
  }, [assistantId, queryClient]);

  const provisionProviderKey = useCallback(
    async (providerName: string, key: string): Promise<void> => {
      try {
        const resolvedId = await resolveAssistantId();
        if (!resolvedId) {
          toast.error("No assistant found. Please hatch an assistant first.");
          throw new Error("No assistant found");
        }
        const { data } = await secretsPost({
          path: { assistant_id: resolvedId },
          body: { value: key, type: "api_key", name: providerName },
          throwOnError: true,
        });
        assertProvisionSuccess(data);
      } catch (error) {
        if (!(error instanceof Error && error.message === "No assistant found")) {
          toast.error(`Failed to save ${providerName} API key. Please try again.`);
        }
        captureError(error, { context: "provision_provider_key" });
        throw error;
      }
    },
    [resolveAssistantId],
  );

  const patchDaemonConfig = useCallback(
    async (partial: Record<string, unknown>): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await configPatch({
          path: { assistant_id: resolvedId },
          body: partial,
          throwOnError: true,
        });
      } catch (error) {
        toast.error("Failed to update assistant configuration. Please try again.");
        captureError(error, { context: "patch_daemon_config" });
        throw error;
      } finally {
        invalidateConfig();
      }
    },
    [resolveAssistantId, invalidateConfig],
  );

  const setImageGenModelOnDaemon = useCallback(
    async (modelId: string): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await modelImagegenPut({
          path: { assistant_id: resolvedId },
          body: { modelId },
          throwOnError: true,
        });
      } catch (error) {
        toast.error("Failed to update image generation model. Please try again.");
        captureError(error, { context: "set_image_gen_model" });
        throw error;
      } finally {
        invalidateConfig();
      }
    },
    [resolveAssistantId, invalidateConfig],
  );

  return {
    assistantId,
    assistantHandle,
    config: configQuery.data,
    configQuery,
    profiles,
    profileOrder,
    orderedProfiles,
    activeProfile,
    callSites,
    invalidateConfig,
    provisionProviderKey,
    patchDaemonConfig,
    setImageGenModelOnDaemon,
  };
}

/**
 * Mutation hook for daemon config patches.
 *
 * Wraps `configPatch` in a `useMutation` with automatic cache invalidation
 * on settle. Consumers get `isPending`, `error`, and `reset()` for free
 * instead of maintaining parallel `useState` for loading/error state.
 *
 * For operations needing optimistic UI (toggle, reorder), callers use
 * `onMutate` / `onError` with `queryClient.setQueryData` to write the
 * cache optimistically and roll back on failure.
 */
export function useDaemonConfigMutation() {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      if (!assistantId) throw new Error("No assistant found");
      const { data } = await configPatch({
        path: { assistant_id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: assistantDaemonConfigQueryKey(assistantId),
      });
    },
  });
}
