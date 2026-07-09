/**
 * TanStack Query options for the backend-agnostic `GET /memory-graph` daemon
 * endpoint. The POST-less read returns the assistant's memory as a canonical
 * node/edge graph; `supported: false` maps to a `{ kind: "unsupported" }`
 * success-shaped result so React Query does not treat "this backend has no
 * graph" as a retryable failure. Transport / non-2xx errors throw.
 */

import { queryOptions } from "@tanstack/react-query";

import { memorygraphGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { MemoryGraphResult } from "./types";

const FAILURE_MESSAGE = "Failed to load the memory graph.";

export function memoryGraphOptions(assistantId: string) {
  return queryOptions<MemoryGraphResult>({
    queryKey: ["memory-graph", assistantId] as const,
    // The daemon rebuilds the whole graph per request (page reads + a
    // selection-log scan), and the graph only changes on the timescale of
    // memory writes — don't refire it on every window refocus.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MemoryGraphResult> => {
      const { data, error, response } = await memorygraphGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });

      assertHasResponse(response, error, FAILURE_MESSAGE);

      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, FAILURE_MESSAGE),
        );
      }

      if (!data || data.supported === false) {
        return { kind: "unsupported" };
      }

      return { kind: "ready", graph: data };
    },
  });
}
