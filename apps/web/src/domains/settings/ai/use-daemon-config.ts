/**
 * Daemon config hooks — query, mutation, and domain-specific helpers.
 *
 * Architecture:
 * - `useDaemonConfigQuery` — read-only hook returning the config + derived slices.
 * - `useDaemonConfigMutation` — TanStack mutation wrapping `configPatch`.
 * - `useProvisionProviderKey` — standalone hook for provisioning API keys.
 *
 * Every consumer gets the same TanStack Query cache entry (queries are
 * deduplicated by key). Mutations automatically invalidate the cache on
 * settle, propagating updates to all consumers.
 */

import { useCallback, useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { configGet, configPatch, secretsPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import { assertProvisionSuccess, buildOrderedProfiles } from "@/domains/settings/ai/ai-utils";
import type { CallSiteOverrideDraft, DaemonConfig, DaemonConfigPatch, ProfileEntry } from "@/domains/settings/ai/ai-types";

// ---------------------------------------------------------------------------
// useDaemonConfigQuery — read-only config + derived slices
// ---------------------------------------------------------------------------

/**
 * Read-only hook for the daemon config query and derived slices.
 *
 * Typed slices (profiles, profileOrder, etc.) are derived via `useMemo`
 * from the raw config — no `useState` copies, no hydration effects.
 * Consumers that only read config pay no mutation overhead.
 */
export function useDaemonConfigQuery() {
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

  return {
    assistantId,
    assistantHandle,
    config,
    configQuery,
    profiles,
    profileOrder,
    orderedProfiles,
    activeProfile,
    callSites,
    invalidateConfig,
  };
}

// ---------------------------------------------------------------------------
// useDaemonConfigMutation — configPatch + auto-invalidation
// ---------------------------------------------------------------------------

/**
 * Mutation hook for daemon config patches.
 *
 * Wraps `configPatch` in a `useMutation` with automatic cache invalidation
 * on settle. Resolves the assistant ID lazily via `fetchQuery` so callers
 * don't need to gate on the assistant list being loaded.
 */
export function useDaemonConfigMutation() {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  const resolveAssistantId = useCallback(async (): Promise<string> => {
    if (assistantId) return assistantId;
    const list = await queryClient.fetchQuery(assistantsListOptions());
    const resolved = list.results?.[0]?.id;
    if (!resolved) throw new Error("No assistant found");
    return resolved;
  }, [assistantId, queryClient]);

  return useMutation({
    mutationFn: async (body: DaemonConfigPatch) => {
      const resolvedId = await resolveAssistantId();
      const { data } = await configPatch({
        path: { assistant_id: resolvedId },
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

// ---------------------------------------------------------------------------
// useProvisionProviderKey — API key provisioning
// ---------------------------------------------------------------------------

/**
 * Hook for provisioning provider API keys on the daemon.
 *
 * Used by web-search-card and image-generation-card to store BYOK
 * credentials. Returns a stable callback; resolves the assistant ID
 * lazily if it hasn't loaded yet.
 */
export function useProvisionProviderKey() {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  const resolveAssistantId = useCallback(async (): Promise<string | null> => {
    if (assistantId) return assistantId;
    const list = await queryClient.fetchQuery(assistantsListOptions());
    return list.results?.[0]?.id ?? null;
  }, [assistantId, queryClient]);

  return useCallback(
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
}
