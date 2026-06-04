/**
 * TanStack Query options for the `POST /memory/v2/list-concept-pages`
 * daemon endpoint.
 *
 * The generated SDK exposes this as a mutation (POST), but semantically
 * it's a read — the POST body is empty and the response is a list. This
 * factory returns `queryOptions` so consumers can use `useQuery` with
 * proper caching and automatic refetch.
 *
 * The daemon returns **409 + `MEMORY_V2_DISABLED`** when the workspace
 * doesn't have memory-v2 enabled. Instead of letting TanStack Query
 * treat this as a retryable error, the queryFn maps it to
 * `{ kind: "disabled" }` — a success-shaped result the UI can render
 * as a dedicated empty state. See `ListConceptPagesResult` for the
 * two-state contract.
 */

import { queryOptions } from "@tanstack/react-query";

import { memoryV2ListconceptpagesPost } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { ListConceptPagesResult } from "./types";

export function listConceptPagesOptions(assistantId: string) {
  return queryOptions<ListConceptPagesResult>({
    queryKey: ["memory-v2", "list-concept-pages", assistantId] as const,
    queryFn: async (): Promise<ListConceptPagesResult> => {
      const { data, error, response } = await memoryV2ListconceptpagesPost({
        path: { assistant_id: assistantId },
        body: {},
        throwOnError: false,
      });

      assertHasResponse(response, error, "Failed to load concept pages.");

      if (response.status === 409) {
        const errObj = error as Record<string, unknown> | undefined;
        const nested = errObj?.error as Record<string, unknown> | undefined;
        if (nested?.code === "MEMORY_V2_DISABLED") {
          return { kind: "disabled" };
        }
        throw new ApiError(
          response.status,
          extractErrorMessage(
            error,
            response,
            "Failed to load concept pages.",
          ),
        );
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(
            error,
            response,
            "Failed to load concept pages.",
          ),
        );
      }

      return { kind: "success", pages: data?.pages ?? [] };
    },
  });
}
