import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { inferenceProviderconnectionsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { inferenceProviderconnectionsGet } from "@/generated/daemon/sdk.gen";
import type { InferenceProviderconnectionsGetResponse } from "@/generated/daemon/types.gen";
import { recordDiagnostic } from "@/lib/diagnostics";
import { captureError } from "@/lib/sentry/capture-error";
import { shouldRetryQuery } from "@/utils/query-retry";
import {
  RequestTimeoutError,
  runWithRequestTimeout,
} from "@/utils/request-timeout";

/**
 * Upper bound for one provider-connections request. The daemon answers the
 * list route in milliseconds, so anything near this bound is a stalled
 * request, not a slow one: settling as an error beats a loading state the
 * user cannot leave.
 */
export const PROVIDER_CONNECTIONS_TIMEOUT_MS = 15_000;

interface UseProviderConnectionsOptions {
  /** Gate for callers that fetch lazily (a closed modal, a dark feature). */
  enabled?: boolean;
  staleTime?: number;
}

/**
 * Provider connections for an assistant, on the generated query key so every
 * consumer shares one cache entry, one in-flight request, and one
 * loading/error/retry state.
 *
 * The request is bounded (`PROVIDER_CONNECTIONS_TIMEOUT_MS`) and each stage of
 * its lifecycle lands in the diagnostics ring, so a request that stalls before
 * dispatch is distinguishable from one that stalls waiting on a response.
 * Diagnostics carry the assistant ID, elapsed time, and connection count only:
 * never credentials or response bodies.
 */
export function useProviderConnections(
  assistantId: string | null | undefined,
  options: UseProviderConnectionsOptions = {},
): UseQueryResult<InferenceProviderconnectionsGetResponse> {
  const requestOptions = { path: { assistant_id: assistantId ?? "" } };

  return useQuery({
    queryKey: inferenceProviderconnectionsGetQueryKey(requestOptions),
    queryFn: async ({ signal }) => {
      const startedAt = Date.now();
      const elapsedMs = () => Date.now() - startedAt;
      recordDiagnostic("provider_connections_query_invoked", { assistantId });

      try {
        const data = await runWithRequestTimeout({
          timeoutMs: PROVIDER_CONNECTIONS_TIMEOUT_MS,
          signal,
          run: async (requestSignal) => {
            recordDiagnostic("provider_connections_request_dispatched", {
              assistantId,
              elapsedMs: elapsedMs(),
            });
            const { data: response } = await inferenceProviderconnectionsGet({
              ...requestOptions,
              signal: requestSignal,
              throwOnError: true,
            });
            return response;
          },
        });
        recordDiagnostic("provider_connections_response_received", {
          assistantId,
          elapsedMs: elapsedMs(),
          connectionCount: data.connections?.length ?? 0,
        });
        return data;
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          recordDiagnostic("provider_connections_client_timeout", {
            assistantId,
            elapsedMs: elapsedMs(),
            timeoutMs: error.timeoutMs,
          });
          captureError(error, {
            context: "provider-connections-client-timeout",
            tags: { area: "settings-providers" },
            extra: { assistantId, elapsedMs: elapsedMs() },
          });
          throw error;
        }
        recordDiagnostic("provider_connections_error_received", {
          assistantId,
          elapsedMs: elapsedMs(),
          errorName: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
    // A timed-out request already waited out the bound, so retrying it behind
    // the user's back only pushes the terminal state further away: the Retry
    // control owns that decision. Other failures keep the global policy.
    retry: (failureCount, error) =>
      error instanceof RequestTimeoutError
        ? false
        : shouldRetryQuery(failureCount, error),
    enabled: (options.enabled ?? true) && !!assistantId,
    ...(options.staleTime !== undefined
      ? { staleTime: options.staleTime }
      : {}),
  });
}
