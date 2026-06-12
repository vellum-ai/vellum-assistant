/**
 * Daemon config hooks — query, mutation, and domain-specific helpers.
 *
 * Architecture:
 * - `useAssistantId` — shared hook for assistant ID + lazy resolver.
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

import type { CallSiteOverrideDraft, DaemonConfig, DaemonConfigPatch, ProfileEntry } from "@/domains/settings/ai/ai-types";
import { applyConfigPatch, assertProvisionSuccess, buildOrderedProfiles, snapshotPatchedFields } from "@/domains/settings/ai/ai-utils";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import type { ConfigGetData, ConfigGetResponse, ConfigPatchData } from "@/generated/daemon/types.gen";
import { type Options, configGet, configPatch, secretsPost } from "@/generated/daemon/sdk.gen";
import { configGetSetQueryData } from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import { toast } from "@vellumai/design-library/components/toast";

// ---------------------------------------------------------------------------
// useAssistantId — shared assistant ID + lazy resolver
// ---------------------------------------------------------------------------

/**
 * Shared hook for the active assistant's ID and a lazy resolver.
 *
 * Settings content is gated in `SettingsLayout` so the selection store
 * is guaranteed to have a non-null `activeAssistantId` by the time this
 * hook runs. `resolveAssistantId` returns the same value wrapped in a
 * Promise to satisfy the async interface that mutations expect.
 */
export function useAssistantId() {
  const assistantId = useActiveAssistantId();

  const resolveAssistantId = useCallback(
    async (): Promise<string> => assistantId,
    [assistantId],
  );

  return { assistantId, resolveAssistantId };
}

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
export function useDaemonConfigQuery(
  options: { enabled?: boolean } = {},
) {
  const { assistantId } = useAssistantId();
  const enabled = options.enabled ?? true;

  const { data: config } = useQuery({
    queryKey: assistantDaemonConfigQueryKey(assistantId),
    queryFn: async () => {
      const { data } = await configGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      // The generated ConfigGetResponse is wider (index sigs, literal unions)
      // than the hand-written DaemonConfig used by downstream consumers.
      // This cast bridges the two until DaemonConfig is fully replaced.
      return data as DaemonConfig;
    },
    enabled: !!assistantId && enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

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

  return {
    assistantId,
    config,
    profiles,
    profileOrder,
    orderedProfiles,
    activeProfile,
    callSites,
  };
}

// ---------------------------------------------------------------------------
// useDaemonConfigMutation — configPatch + auto-invalidation
// ---------------------------------------------------------------------------

/**
 * Mutation hook for daemon config patches.
 *
 * Wraps `configPatch` with optimistic cache updates and auto-invalidation:
 * - `onMutate` applies the patch to the query cache immediately via
 *   `applyConfigPatch`, so consumers see the new values before the server
 *   responds. This prevents derived state (e.g. `configChanged`) from
 *   briefly reverting to stale values during the refetch window.
 * - `onError` rolls the cache back to the pre-mutation snapshot.
 * - `onSettled` invalidates the cache so a refetch replaces the optimistic
 *   data with the server's authoritative response.
 *
 * Resolves the assistant ID lazily via `useAssistantId` so callers don't
 * need to gate on the assistant list being loaded.
 */
export function useDaemonConfigMutation() {
  const queryClient = useQueryClient();
  const { assistantId, resolveAssistantId } = useAssistantId();

  return useMutation({
    mutationFn: async (body: DaemonConfigPatch) => {
      const resolvedId = await resolveAssistantId();
      // DaemonConfigPatch is intentionally stricter than the generated
      // ConfigPatchData["body"] (no index sigs → catches key typos). The
      // structural mismatch is only in optional field widths (string vs
      // literal union) — values are always valid at runtime since they come
      // from constrained UI selectors.
      const { data } = await configPatch({
        path: { assistant_id: resolvedId },
        body: body as ConfigPatchData["body"],
        throwOnError: true,
      });
      return { data, resolvedId };
    },
    onMutate: async (body) => {
      if (!assistantId) return;
      const opts = { path: { assistant_id: assistantId } } as Options<ConfigGetData>;
      const queryKey = assistantDaemonConfigQueryKey(assistantId);
      await queryClient.cancelQueries({ queryKey });
      const current = queryClient.getQueryData<DaemonConfig>(queryKey);
      const rollback = current ? snapshotPatchedFields(current, body) : undefined;
      configGetSetQueryData(queryClient, opts, (old) =>
        old
          ? (applyConfigPatch(old as DaemonConfig, body) as ConfigGetResponse)
          : old,
      );
      return { rollback, opts };
    },
    onError: (_err, _body, context) => {
      const { opts, rollback } = context ?? {};
      if (opts && rollback) {
        configGetSetQueryData(queryClient, opts, (old) =>
          old
            ? (applyConfigPatch(old as DaemonConfig, rollback) as ConfigGetResponse)
            : old,
        );
      }
    },
    onSettled: (result) => {
      const idToInvalidate = result?.resolvedId ?? assistantId;
      void queryClient.invalidateQueries({
        queryKey: assistantDaemonConfigQueryKey(idToInvalidate),
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
 * lazily via `useAssistantId` if it hasn't loaded yet.
 */
export function useProvisionProviderKey() {
  const { resolveAssistantId } = useAssistantId();

  return useCallback(
    async (providerName: string, key: string): Promise<void> => {
      try {
        const resolvedId = await resolveAssistantId();
        const { data } = await secretsPost({
          path: { assistant_id: resolvedId },
          body: { value: key, type: "api_key", name: providerName },
          throwOnError: true,
        });
        assertProvisionSuccess(data);
      } catch (error) {
        if (error instanceof Error && error.message === "No assistant found") {
          toast.error("Assistant not ready. Please try again.");
        } else {
          toast.error(`Failed to save ${providerName} API key. Please try again.`);
        }
        captureError(error, { context: "provision_provider_key" });
        throw error;
      }
    },
    [resolveAssistantId],
  );
}
