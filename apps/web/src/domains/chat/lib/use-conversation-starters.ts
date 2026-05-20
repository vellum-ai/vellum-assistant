/**
 * React hook over the conversation-starters daemon client.
 *
 * Polls every 3s while the daemon reports `generating`/`refreshing` and
 * stops once it settles. `staleTime` is 60s so quick re-mounts reuse the
 * cached result. When `assistantId` is missing the hook returns a stable
 * idle result without making a network call.
 */

import { useQuery } from "@tanstack/react-query";

import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants.js";

import {
  listConversationStarters,
  type ConversationStarter,
  type ConversationStartersStatus,
  type ListConversationStartersResult,
} from "@/domains/chat/utils/conversation-starters.js";

const POLL_INTERVAL_MS = 3000;
const STALE_TIME_MS = 60_000;

export interface UseConversationStartersResult {
  starters: ConversationStarter[];
  status: ConversationStartersStatus | "idle";
  isLoading: boolean;
  refetch: () => Promise<void>;
}

const NOOP_REFETCH = async (): Promise<void> => {};

const IDLE_RESULT: UseConversationStartersResult = {
  starters: [],
  status: "idle",
  isLoading: false,
  refetch: NOOP_REFETCH,
};

/** Polling decision (exposed for unit testing). */
export function shouldPoll(
  status: ConversationStartersStatus | undefined,
): number | false {
  if (status === "generating" || status === "refreshing") {
    return POLL_INTERVAL_MS;
  }
  return false;
}

export function useConversationStarters(
  assistantId: string | null | undefined,
): UseConversationStartersResult {
  const enabled = Boolean(assistantId);

  const query = useQuery<ListConversationStartersResult>({
    queryKey: ["conversation-starters", assistantId],
    queryFn: () =>
      listConversationStarters(assistantId!, {
        limit: MAX_CONVERSATION_STARTER_CHIPS,
      }),
    enabled,
    staleTime: STALE_TIME_MS,
    refetchInterval: (q) => shouldPoll(q.state.data?.status),
  });

  if (!enabled) {
    return IDLE_RESULT;
  }

  return {
    starters: query.data?.starters ?? [],
    status: query.data?.status ?? "generating",
    isLoading: query.isLoading,
    refetch: async () => {
      await query.refetch();
    },
  };
}
