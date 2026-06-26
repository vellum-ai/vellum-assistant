/**
 * Provides the new-thread suggestions library data behind a stable shape.
 *
 * The data is currently mocked: `featured` and `groups` come from
 * {@link MOCK_SUGGESTION_GROUPS}. The result shape is intentionally stable so
 * the source can later swap to a real query — installed plugins/skills plus a
 * Vellum-curated source — without touching consumers.
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
      featured: getFeaturedSuggestions(3),
      groups: MOCK_SUGGESTION_GROUPS,
    }),
    [],
  );
}
