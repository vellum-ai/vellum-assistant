import { useRef } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  client,
  assertHasResponse,
  SDK_BASE_OPTIONS,
} from "@/domains/chat/api/client";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

const STALE_TIME_MS = 5 * 60 * 1000;

interface IdentityIntroResponse {
  greetings?: string[];
  /** @deprecated — kept for backwards compat with older daemons */
  text?: string;
}

async function fetchIdentityIntro(
  assistantId: string,
): Promise<string[] | null> {
  try {
    const { data, error, response } = await client.get<
      IdentityIntroResponse,
      unknown
    >({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/identity/intro",
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch identity intro");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    if (Array.isArray(data.greetings) && data.greetings.length > 0) {
      return data.greetings;
    }

    if (typeof data.text === "string" && data.text.trim()) {
      return [data.text.trim()];
    }

    return null;
  } catch {
    return null;
  }
}

export function useEmptyStateGreeting(
  assistantId: string | null | undefined,
): string {
  const enabled = Boolean(assistantId);
  const indexRef = useRef(-1);

  const query = useQuery<string[] | null>({
    queryKey: ["identity-intro", assistantId],
    queryFn: () => fetchIdentityIntro(assistantId!),
    enabled,
    staleTime: STALE_TIME_MS,
  });

  const greetings = query.data;
  if (!greetings || greetings.length === 0) {
    return DEFAULT_EMPTY_STATE_GREETING;
  }

  if (indexRef.current < 0) {
    indexRef.current = Math.floor(Math.random() * greetings.length);
  }

  return greetings[indexRef.current % greetings.length]!;
}
