/**
 * Returns the featured suggestions and grouped suggestions for the new-thread
 * empty state. Data is fetched from the daemon's thread-suggestions endpoint,
 * which annotates each requirement's status based on which OAuth providers are
 * connected for this assistant. Falls back to the mock catalog while loading.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { threadsuggestionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ThreadsuggestionsGetResponse } from "@/generated/daemon/types.gen";
import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";
import {
  MOCK_SUGGESTION_GROUPS,
  getFeaturedSuggestions,
} from "@/domains/chat/suggestions/mock-suggestions";

const STALE_TIME_MS = 5 * 60 * 1000;

function toClientGroups(data: ThreadsuggestionsGetResponse): SuggestionGroup[] {
  return (data.groups as SuggestionGroup[]);
}

function toFeatured(
  groups: SuggestionGroup[],
  count: number,
): ThreadSuggestion[] {
  return groups.flatMap((g) => g.suggestions).slice(0, count);
}

export interface UseThreadSuggestionsResult {
  featured: ThreadSuggestion[];
  groups: SuggestionGroup[];
  isLoading: boolean;
}

export function useThreadSuggestions(
  assistantId: string | null,
): UseThreadSuggestionsResult {
  const enabled = Boolean(assistantId);
  const { data, isLoading } = useQuery({
    ...threadsuggestionsGetOptions({
      path: { assistant_id: assistantId! },
    }),
    enabled,
    staleTime: STALE_TIME_MS,
  });

  return useMemo(() => {
    if (!data) {
      return {
        featured: getFeaturedSuggestions(),
        groups: MOCK_SUGGESTION_GROUPS,
        isLoading: enabled && isLoading,
      };
    }
    const groups = toClientGroups(data);
    const featured = toFeatured(groups, data.featuredCount);
    return { featured, groups, isLoading: false };
  }, [data, enabled, isLoading]);
}
