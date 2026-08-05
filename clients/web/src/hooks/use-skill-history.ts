/**
 * Read a skill's recent revisions for the skill detail view.
 *
 * Deliberately not version-gated. This is a read whose only fallback is "the
 * feature is absent", which is exactly what an assistant without the route
 * produces: `fetchSkillHistory` maps its 404 to `null`, the History tab hides,
 * and the detail page renders the way it did before revisions existed. That is
 * the documented exemption in BACKWARDS_COMPAT.md ("When a gate is
 * unnecessary"), and it lets same-source self-hosted setups (which report the
 * last released version while running unreleased code) get the tab without a
 * debug override.
 *
 * `null` and an empty `revisions` array mean different things and must stay
 * distinct: `null` is "this assistant cannot report history", while `[]` is
 * "history is available and this skill has no recorded edits".
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
    /** The connected assistant cannot report history, so hide the surface. */
    isUnsupported: query.isSuccess && query.data === null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
