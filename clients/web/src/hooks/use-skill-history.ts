/**
 * Read a skill's recent revisions for the skill detail view.
 *
 * Deliberately not version-gated. This is a read whose only fallback is "the
 * feature is absent", which is exactly what an assistant without the route
 * produces: `fetchSkillHistory` maps its 404 to `null` and the detail page
 * renders just the files card. That is the documented exemption in
 * BACKWARDS_COMPAT.md ("When a gate is unnecessary"), and it lets same-source
 * self-hosted setups (which report the last released version while running
 * unreleased code) get the tab without a debug override.
 *
 * `null` (this assistant cannot report history) and `[]` (it can, and this
 * skill has no recorded edits) stay distinct in the fetch, because the 404
 * mapping is what makes the missing route degrade quietly. Callers are free to
 * treat them the same: the detail page shows the History tab only when there
 * are revisions to show, which both cases fail for the same reason from a
 * reader's point of view.
 */

import { useQuery } from "@tanstack/react-query";

import { skillsByIdHistoryGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { skillsByIdHistoryGet } from "@/generated/daemon/sdk.gen";
import type { SkillsByIdHistoryGetResponse } from "@/generated/daemon/types.gen";
import { toApiError } from "@/utils/api-errors";

export type SkillHistory = SkillsByIdHistoryGetResponse;
export type SkillRevision = SkillHistory["revisions"][number];

/**
 * Fetch a skill's history, mapping a missing route to the feature-off value.
 *
 * Other HTTP failures throw a status-carrying error via {@link toApiError}:
 * the `throwOnError: false` read bypasses the client's error interceptor, so
 * the status has to be attached here for the global no-retry-4xx predicate to
 * apply. A network error (no response at all) rethrows raw so it retries as a
 * transient failure.
 */
export async function fetchSkillHistory(
  assistantId: string,
  skillId: string,
  signal?: AbortSignal,
): Promise<SkillHistory | null> {
  const { data, error, response } = await skillsByIdHistoryGet({
    path: { assistant_id: assistantId, id: skillId },
    throwOnError: false,
    signal,
  });
  if (!response || !response.ok) {
    if (response?.status === 404) {
      return null;
    }
    if (response) {
      throw toApiError(error, response);
    }
    throw error ?? new Error("Failed to fetch skill history.");
  }
  return data ?? null;
}

/**
 * Whether the skill detail page should offer its History tab.
 *
 * A tab is a promise that there is something behind it, so an empty result
 * hides the strip entirely rather than opening onto an empty state. A FAILED
 * read is not empty: collapsing it into the same case would make a transient
 * failure indistinguishable from a skill that has never been edited, leaving
 * the reader no signal and no way to retry short of reloading.
 *
 * Pure and exported so the distinction between "nothing to show" and "could
 * not find out" is pinned by a test rather than by reading the JSX.
 */
export function shouldShowHistoryTab(state: {
  isLoading: boolean;
  isError: boolean;
  revisionCount: number;
}): boolean {
  if (state.isLoading) {
    return false;
  }
  return state.isError || state.revisionCount > 0;
}

export function useSkillHistory(assistantId: string | null, skillId: string) {
  const enabled = Boolean(assistantId && skillId);

  const query = useQuery({
    queryKey: skillsByIdHistoryGetQueryKey({
      path: { assistant_id: assistantId ?? "", id: skillId },
    }),
    queryFn: ({ signal }) =>
      fetchSkillHistory(assistantId ?? "", skillId, signal),
    enabled,
    // Revisions change only when the workspace commits, which no client
    // action triggers; a focus refetch would just re-issue the request (and,
    // against an older assistant, the 404).
    refetchOnWindowFocus: false,
  });

  return {
    history: query.data ?? null,
    revisions: query.data?.revisions ?? [],
    truncatedByCompaction: query.data?.truncatedByCompaction ?? false,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
