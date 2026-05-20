export interface ConceptPageSummary {
  slug: string;
  bodyBytes: number;
  edgeCount: number;
  updatedAtMs: number;
}

/**
 * Outcome of `listConceptPages()`.
 *
 * Two-state contract: `disabled` is its own success-shaped result so the
 * discriminated render can show the explicit "Memories are disabled" empty
 * state without React Query treating it as a retryable failure. Transport /
 * non-409 server errors throw; the panel reads `query.isError` to render
 * the error state.
 */
export type ListConceptPagesResult =
  | { kind: "success"; pages: ConceptPageSummary[] }
  | { kind: "disabled" };

export type SortOrder = "recent" | "az";
