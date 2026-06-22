import { queryOptions } from "@tanstack/react-query";

import { memoryV2ConceptpagePost } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";

/**
 * Query helper for the inspector's Memory (v2) tab. Fetches the rendered
 * (frontmatter + body) markdown for a single concept-page slug from
 * `POST /memory/v2/concept-page`, so an expanded activation row can show
 * what actually got injected — matching the macOS inspector's
 * `ConceptPageContentView`.
 *
 * The generated SDK exposes the route as a mutation (POST), but
 * semantically it's a read — the body is just a slug. This factory
 * returns `queryOptions` so the inspector caches per-slug and fetches
 * lazily on row expand.
 *
 * A **404** means the slug has no on-disk page (a stale Qdrant entry).
 * Like the macOS client, any failure is folded into `{ kind: "missing" }`
 * — a success-shaped result the UI renders as a "page not found"
 * affordance — rather than surfacing a retryable error inside the row.
 */

export type ConceptPageResult =
  | { kind: "loaded"; rendered: string }
  | { kind: "missing" };

export function conceptPageQueryOptions(assistantId: string, slug: string) {
  return queryOptions<ConceptPageResult>({
    queryKey: ["memory-v2", "concept-page", assistantId, slug] as const,
    queryFn: async (): Promise<ConceptPageResult> => {
      const { data, error, response } = await memoryV2ConceptpagePost({
        path: { assistant_id: assistantId },
        body: { slug },
        throwOnError: false,
      });

      assertHasResponse(response, error, "Failed to load concept page.");

      // 404 = stale slug; any other non-ok status is surfaced the same way
      // so an expanded activation row degrades gracefully instead of
      // erroring. Mirrors the macOS `fetchConceptPage` behaviour.
      if (!response.ok) {
        return { kind: "missing" };
      }

      const rendered =
        (data as { rendered?: string } | undefined)?.rendered ?? "";
      return { kind: "loaded", rendered };
    },
    staleTime: 5 * 60_000,
  });
}
