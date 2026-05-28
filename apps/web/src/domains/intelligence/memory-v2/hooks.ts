import { useQuery } from "@tanstack/react-query";

import { listConceptPages, readConceptPage } from "./api";
import type { ListConceptPagesResult } from "./types";

/** Fetches the paginated list of memory-v2 concept pages for the assistant. */
export function useListConceptPages(assistantId: string) {
  return useQuery<ListConceptPagesResult>({
    queryKey: ["memory-v2-concept-pages", assistantId],
    queryFn: () => listConceptPages(assistantId),
    staleTime: 30_000,
  });
}

/** Fetches the full content of a single concept page by slug. */
export function useReadConceptPage(assistantId: string, slug: string) {
  return useQuery<string | null>({
    queryKey: ["concept-page", assistantId, slug],
    queryFn: () => readConceptPage(assistantId, slug),
    staleTime: 60_000,
  });
}
