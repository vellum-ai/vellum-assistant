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
 */

import { useCallback } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import {
  configGet,
  secretsPost,
  modelImagegenPut,
} from "@/generated/daemon/sdk.gen";
import { client } from "@/generated/api/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import { assertProvisionSuccess } from "@/domains/settings/ai/ai-utils";
import type { DaemonConfig } from "@/domains/settings/ai/ai-types";

/**
 * Hook providing the daemon config query and common mutation helpers.
 *
 * Each consumer gets the same TanStack Query cache entry (queries are
 * deduplicated by key). Cards that only read config pay no extra cost.
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

  // PATCHes `assistants/{id}/config`, which Django's RuntimeProxyWildcardView
  // forwards to the daemon. The generated `configPatch` has `body?: never`
  // because the OpenAPI spec doesn't define a request body yet, so we use the
  // raw client for now.
  const patchConfigMutation = useMutation({
    mutationFn: async (vars: {
      assistantId: string;
      partial: Record<string, unknown>;
    }) => {
      const { data } = await client.patch<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: vars.assistantId },
        body: vars.partial,
        throwOnError: true,
      });
      return data;
    },
  });

  const patchDaemonConfig = useCallback(
    async (partial: Record<string, unknown>): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await patchConfigMutation.mutateAsync({
          assistantId: resolvedId,
          partial,
        });
      } catch (error) {
        toast.error("Failed to update assistant configuration. Please try again.");
        captureError(error, { context: "patch_daemon_config" });
        throw error;
      }
    },
    [patchConfigMutation, resolveAssistantId],
  );

  const putImageGenModelMutation = useMutation({
    mutationFn: async (vars: { assistantId: string; modelId: string }) => {
      const { data } = await modelImagegenPut({
        path: { assistant_id: vars.assistantId },
        body: { modelId: vars.modelId },
        throwOnError: true,
      });
      return data;
    },
  });

  const setImageGenModelOnDaemon = useCallback(
    async (modelId: string): Promise<void> => {
      const resolvedId = await resolveAssistantId();
      if (!resolvedId) {
        toast.error("No assistant found. Please hatch an assistant first.");
        throw new Error("No assistant found");
      }
      try {
        await putImageGenModelMutation.mutateAsync({
          assistantId: resolvedId,
          modelId,
        });
      } catch (error) {
        toast.error("Failed to update image generation model. Please try again.");
        captureError(error, { context: "set_image_gen_model" });
        throw error;
      }
    },
    [putImageGenModelMutation, resolveAssistantId],
  );

  return {
    assistantId,
    assistantHandle,
    config: configQuery.data,
    configQuery,
    invalidateConfig,
    provisionProviderKey,
    patchDaemonConfig,
    setImageGenModelOnDaemon,
  };
}
