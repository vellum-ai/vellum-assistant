/**
 * Conversation-starter query backed by the generated daemon SDK.
 *
 * Polls every 3 s while the daemon reports `generating`/`refreshing` and
 * stops once it settles. `staleTime` is 60 s so quick re-mounts reuse the
 * cached result. When `assistantId` is missing the hook returns a stable
 * idle result without making a network call.
 */

import { useQuery } from "@tanstack/react-query";

import { conversationstartersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type {
  ConversationStarter,
  ConversationStartersStatus,
} from "@/domains/chat/utils/conversation-starters";

import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants";

const STALE_TIME_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

const DEFAULT_OFFSET = 0;

function shouldPoll(
  status: ConversationStartersStatus | undefined,
): number | false {
  if (status === "generating" || status === "refreshing") return POLL_INTERVAL_MS;
  return false;
}

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

export function useConversationStarters(
  assistantId: string | null | undefined,
): UseConversationStartersResult {
  const enabled = Boolean(assistantId);

  const query = useQuery({
    ...conversationstartersGetOptions({
      path: { assistant_id: assistantId! },
      query: {
        limit: MAX_CONVERSATION_STARTER_CHIPS,
        offset: DEFAULT_OFFSET,
      },
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
