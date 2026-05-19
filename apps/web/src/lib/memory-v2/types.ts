export interface ConceptPageSummary {
  slug: string;
  bodyBytes: number;
  edgeCount: number;
  updatedAtMs: number;
}

/**
 * Outcome of `listConceptPages()`.
 *
 * Mirrors the macOS `MemoryV2ListConceptPagesResult` 3-state contract, but
 * collapsed to 2 cases for the web client because React Query handles the
 * `error` state via `query.isError` directly. Transport / non-409 server
 * errors throw; the panel reads `query.isError` to render the error state.
 *
 * `disabled` is its own success-shaped result so the discriminated render
 * can show the explicit "Memories are disabled" empty state without React
 * Query treating it as a retryable failure.
 */
export type ListConceptPagesResult =
  | { kind: "success"; pages: ConceptPageSummary[] }
  | { kind: "disabled" };

export type SortOrder = "recent" | "az";
