import { useQuery } from "@tanstack/react-query";

import { listConceptPages, readConceptPage } from "@/lib/memory-v2/api.js";
import type { ListConceptPagesResult } from "@/lib/memory-v2/types.js";

export function useListConceptPages(assistantId: string) {
  return useQuery<ListConceptPagesResult>({
    queryKey: ["memory-v2-concept-pages", assistantId],
    queryFn: () => listConceptPages(assistantId),
    staleTime: 30_000,
  });
}

export function useReadConceptPage(assistantId: string, slug: string) {
  return useQuery<string | null>({
    queryKey: ["concept-page", assistantId, slug],
    queryFn: () => readConceptPage(assistantId, slug),
    staleTime: 60_000,
  });
}
