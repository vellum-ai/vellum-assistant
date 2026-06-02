/**
 * Shared TanStack Query hook for the daemon config endpoint.
 *
 * Every service card in the AI settings page calls this hook
 * independently; TanStack Query deduplicates the network request
 * and shares the cache entry across all consumers.
 *
 * The daemon config endpoint returns freeform JSON (`unknown`).
 * This hook applies {@link parseDaemonConfig} at the single trust
 * boundary so consumers receive the typed {@link DaemonConfig}
 * projection without scattering `as` casts.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  configGetOptions,
  configGetQueryKey,
  secretsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { ConfigGetData } from "@/generated/daemon/types.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";

import type { DaemonConfig } from "@/domains/settings/ai/ai-types";
import { parseDaemonConfig } from "@/domains/settings/ai/ai-utils";

// ---------------------------------------------------------------------------
// Query hook
// ---------------------------------------------------------------------------

function configQueryOptions(assistantId: string | undefined) {
  return configGetOptions({
    path: { assistant_id: assistantId ?? "" },
  } as Options<ConfigGetData>);
}

/**
 * Fetches and parses the daemon config for the active assistant.
 *
 * Returns `{ assistantId, config, queryKey }` so consumers can
 * derive their own slice and invalidate after mutations.
 */
export function useDaemonConfig() {
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  const queryOpts = configQueryOptions(assistantId);

  const { data: rawConfig } = useQuery({
    ...queryOpts,
    enabled: !!assistantId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const config: DaemonConfig = rawConfig ? parseDaemonConfig(rawConfig) : {};

  return { assistantId, config, queryKey: queryOpts.queryKey } as const;
}

// ---------------------------------------------------------------------------
// Invalidation helper — uses the generated query key shape so both
// inline invalidations and SSE sync target the same cache entry.
// ---------------------------------------------------------------------------

export function invalidateDaemonConfig(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string | undefined,
): void {
  if (!assistantId) return;
  void queryClient.invalidateQueries({
    queryKey: configGetQueryKey({
      path: { assistant_id: assistantId },
    } as Options<ConfigGetData>),
  });
}

// ---------------------------------------------------------------------------
// Mutation options — the config PATCH endpoint accepts freeform JSON but
// the OpenAPI spec doesn't declare a requestBody, so the generated
// `configPatchMutation` types `body` as `never`. This custom factory
// provides a correctly typed mutation until the spec is updated.
// ---------------------------------------------------------------------------

export function daemonConfigPatchMutation() {
  return {
    mutationFn: async (vars: {
      path: { assistant_id: string };
      body: Record<string, unknown>;
    }) => {
      const { data } = await daemonClient.patch<
        Record<string, unknown>,
        unknown,
        true
      >({
        url: "/v1/assistants/{assistant_id}/config",
        path: vars.path,
        body: vars.body,
        throwOnError: true,
      });
      return data;
    },
  };
}

export { secretsPostMutation };
