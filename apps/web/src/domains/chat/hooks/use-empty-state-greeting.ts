/**
 * React hook that fetches a personalized empty-state greeting from the daemon.
 *
 * Calls `GET /v1/assistants/{assistant_id}/identity/intro` which returns a
 * deterministic greeting derived from the assistant's IDENTITY.md name (e.g.
 * "Hi, I'm Pax!"). Falls back to {@link DEFAULT_EMPTY_STATE_GREETING} when the
 * assistant ID is missing, the daemon is unreachable, or the response is empty.
 *
 * The query has a long `staleTime` (5 minutes) since the intro text only
 * changes when the user renames the assistant — a rare operation.
 */

import { useQuery } from "@tanstack/react-query";

import { identityIntroGet } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

const STALE_TIME_MS = 5 * 60 * 1000;

async function fetchIdentityIntro(assistantId: string): Promise<string | null> {
  try {
    const { data, error, response } = await identityIntroGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch identity intro");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    const text = typeof data.text === "string" ? data.text.trim() : null;
    return text || null;
  } catch {
    return null;
  }
}

export function useEmptyStateGreeting(
  assistantId: string | null | undefined,
): string {
  const enabled = Boolean(assistantId);

  const query = useQuery<string | null>({
    queryKey: ["identity-intro", assistantId],
    queryFn: () => fetchIdentityIntro(assistantId!),
    enabled,
    staleTime: STALE_TIME_MS,
  });

  return query.data ?? DEFAULT_EMPTY_STATE_GREETING;
}
