import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { InferenceProviderconnectionsGetResponse } from "@/generated/daemon/types.gen";
import { recordDiagnostic } from "@/lib/diagnostics";
import { captureError } from "@/lib/sentry/capture-error";
import { shouldRetryQuery } from "@/utils/query-retry";
import {
  RequestAbortedError,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "@/utils/request-timeout";

export const PROVIDER_CONNECTIONS_TIMEOUT_MS = 15_000;

interface UseProviderConnectionsOptions {
  enabled?: boolean;
  staleTime?: number;
}

function refetchUnlessTimedOut(query: { state: { error: unknown } }): boolean {
  return !(query.state.error instanceof RequestTimeoutError);
}

/**
 * Loads provider connections through the generated query while bounding a
 * stalled request. All consumers retain the generated cache key and share the
 * same request, terminal state, and explicit recovery path.
 */
export function useProviderConnections(
  assistantId: string | null | undefined,
  options: UseProviderConnectionsOptions = {},
): UseQueryResult<InferenceProviderconnectionsGetResponse> {
  const baseOptions = inferenceProviderconnectionsGetOptions({
    path: { assistant_id: assistantId ?? "" },
  });
  const queryClient = useQueryClient();
  const cachedRequestTimedOut =
    queryClient.getQueryState(baseOptions.queryKey)?.error instanceof
    RequestTimeoutError;

  return useQuery({
    ...baseOptions,
    queryFn: async (context) => {
      const generatedQueryFn = baseOptions.queryFn;
      if (typeof generatedQueryFn !== "function") {
        throw new Error(
          "Generated provider-connections query function is unavailable",
        );
      }

      const startedAt = Date.now();
      const elapsedMs = () => Date.now() - startedAt;
      recordDiagnostic("provider_connections_query_invoked", { assistantId });

      try {
        const data = await runWithRequestTimeout({
          timeoutMs: PROVIDER_CONNECTIONS_TIMEOUT_MS,
          signal: context.signal,
          run: async (requestSignal) => {
            recordDiagnostic("provider_connections_request_dispatched", {
              assistantId,
              elapsedMs: elapsedMs(),
            });
            return await generatedQueryFn({
              ...context,
              signal: requestSignal,
            });
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
        if (error instanceof RequestAbortedError) {
          recordDiagnostic("provider_connections_request_aborted", {
            assistantId,
            elapsedMs: elapsedMs(),
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
    retry: (failureCount, error) =>
      error instanceof RequestTimeoutError ||
      error instanceof RequestAbortedError
        ? false
        : shouldRetryQuery(failureCount, error),
    retryOnMount: !cachedRequestTimedOut,
    refetchOnMount: refetchUnlessTimedOut,
    refetchOnWindowFocus: refetchUnlessTimedOut,
    refetchOnReconnect: refetchUnlessTimedOut,
    enabled: (options.enabled ?? true) && !!assistantId,
    ...(options.staleTime !== undefined
      ? { staleTime: options.staleTime }
      : {}),
  });
}
