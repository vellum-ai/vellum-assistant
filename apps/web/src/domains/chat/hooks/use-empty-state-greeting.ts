/**
 * React hook that fetches a personalized empty-state greeting from the daemon.
 *
 * Calls `GET /v1/assistants/{assistant_id}/identity/intro` which returns a
 * list of greetings derived from SOUL.md, cached model output, fresh
 * generation, or generic fallback options. Falls back to
 * {@link DEFAULT_EMPTY_STATE_GREETING} when the assistant ID is missing, the
 * daemon is unreachable, or the response is empty.
 *
 * The query has a long `staleTime` (5 minutes) since the intro text is cached
 * server-side and refreshed in the background.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { identityIntroGet } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";
import type { IdentityIntroGetResponse } from "@/generated/daemon/types.gen";
import { assistantIdentityIntroQueryKey } from "@/lib/sync/query-tags";

const STALE_TIME_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_INTERVAL_MS = 1500;

type IdentityIntroResponse = Partial<IdentityIntroGetResponse> & {
  greetings?: unknown;
  text?: unknown;
  source?: unknown;
  refreshing?: unknown;
};

interface EmptyStateGreetingQueryResult {
  candidates: readonly string[];
  refreshing: boolean;
}

async function fetchIdentityIntro(
  assistantId: string
): Promise<EmptyStateGreetingQueryResult | null> {
  try {
    const { data, error, response } = await identityIntroGet({
      path: { assistant_id: assistantId },
      query: buildLocalTimeQuery(),
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch identity intro");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    const candidates = normalizeIdentityIntroCandidates(data);
    if (!candidates) {
      return null;
    }

    return {
      candidates,
      refreshing: data.source === "fallback" && data.refreshing === true,
    };
  } catch {
    return null;
  }
}

function buildLocalTimeQuery(date: Date = new Date()): {
  localHour: number;
  localMinute: number;
} {
  return {
    localHour: date.getHours(),
    localMinute: date.getMinutes(),
  };
}

function normalizeIdentityIntroCandidates(
  data: IdentityIntroResponse
): readonly string[] | null {
  if (Array.isArray(data.greetings)) {
    const greetings = data.greetings
      .filter((candidate): candidate is string => typeof candidate === "string")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    if (greetings.length > 0) {
      return greetings;
    }
  }

  const text = typeof data.text === "string" ? data.text.trim() : "";
  return text ? [text] : null;
}

function pickGreetingCandidate(
  candidates: readonly string[] | null | undefined
): string | null {
  if (!candidates || candidates.length === 0) return null;
  const index = Math.min(
    candidates.length - 1,
    Math.floor(Math.random() * candidates.length)
  );
  return candidates[index] ?? null;
}

export function useEmptyStateGreeting(
  assistantId: string | null | undefined
): string {
  const enabled = Boolean(assistantId);

  const query = useQuery<EmptyStateGreetingQueryResult | null>({
    queryKey: assistantIdentityIntroQueryKey(assistantId),
    queryFn: () => fetchIdentityIntro(assistantId!),
    enabled,
    staleTime: STALE_TIME_MS,
    refetchInterval: (query) =>
      query.state.data?.refreshing ? FALLBACK_REFRESH_INTERVAL_MS : false,
  });

  const greeting = useMemo(
    () => pickGreetingCandidate(query.data?.candidates),
    [query.data]
  );

  return greeting ?? DEFAULT_EMPTY_STATE_GREETING;
}
