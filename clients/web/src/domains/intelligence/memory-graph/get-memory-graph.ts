/**
 * TanStack Query options for the backend-agnostic `GET /memory-graph` daemon
 * endpoint. The POST-less read returns the assistant's memory as a canonical
 * node/edge graph; `supported: false` maps to a `{ kind: "unsupported" }`
 * success-shaped result so React Query does not treat "this backend has no
 * graph" as a retryable failure. A 404 (an older assistant predating the route)
 * maps to `unsupported` too, so it degrades to the feature-off empty state
 * rather than an error (see `docs/BACKWARDS_COMPAT.md`). Other non-2xx / transport
 * errors throw.
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

      // An assistant/daemon predating the `/memory-graph` route answers 404;
      // treat that as "not supported here" so an older assistant shows the
      // graceful empty state instead of an error (BACKWARDS_COMPAT read rule).
      if (response.status === 404) {
        return { kind: "unsupported" };
      }

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
