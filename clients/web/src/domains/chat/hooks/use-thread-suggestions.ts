/**
 * Returns the featured suggestions and grouped suggestions for the new-thread
 * empty state. The data comes from the bundled mock suggestion set
 * ({@link MOCK_SUGGESTION_GROUPS}).
 */

import { useMemo } from "react";

import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";
import {
  MOCK_SUGGESTION_GROUPS,
  getFeaturedSuggestions,
} from "@/domains/chat/suggestions/mock-suggestions";

export interface UseThreadSuggestionsResult {
  featured: ThreadSuggestion[];
  groups: SuggestionGroup[];
}

export function useThreadSuggestions(): UseThreadSuggestionsResult {
  return useMemo(
    () => ({
      featured: getFeaturedSuggestions(),
      groups: MOCK_SUGGESTION_GROUPS,
    }),
    [],
  );
}
