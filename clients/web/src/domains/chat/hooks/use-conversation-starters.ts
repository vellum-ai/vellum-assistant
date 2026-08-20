/**
 * Conversation-starter query backed by the generated daemon SDK.
 *
 * Polls every 3 s while the daemon reports `generating`/`refreshing` and
 * stops once it settles. `staleTime` is 60 s so quick re-mounts reuse the
 * cached result. When `assistantId` is missing the hook returns a stable
 * idle result without making a network call.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { conversationstartersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type {
  ConversationStarter,
  ConversationStartersStatus,
} from "@/domains/chat/utils/conversation-starters";

import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants";

const STALE_TIME_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * How long {@link UseConversationStartersResult.isAwaitingStarters} is willing
 * to answer "chips may still arrive" while the daemon keeps reporting that it
 * is generating them. A generation that never lands would otherwise pin the
 * empty state's reserved dock open for the life of the screen, so the wait
 * gets a deadline and the layout always resolves.
 */
export const STARTERS_AWAIT_DEADLINE_MS = 10_000;

const DEFAULT_OFFSET = 0;

function shouldPoll(
  status: ConversationStartersStatus | undefined,
): number | false {
  if (status === "generating" || status === "refreshing") {
    return POLL_INTERVAL_MS;
  }
  return false;
}

export interface UseConversationStartersResult {
  starters: ConversationStarter[];
  status: ConversationStartersStatus | "idle";
  isLoading: boolean;
  /**
   * True while there is nothing to render yet and chips are worth waiting
   * for: the first fetch is in flight, or the daemon reports it is still
   * generating them and the wait is inside
   * {@link STARTERS_AWAIT_DEADLINE_MS}.
   *
   * False once chips land, once the daemon settles on having none, on a
   * failed fetch, on a fetch the browser has paused for being offline, past
   * the deadline, and whenever the query is idle. Every one of those is a
   * state the answer can get stuck in, and the empty state's starter dock
   * holds reserved height while this is true, so it must always resolve.
   */
  isAwaitingStarters: boolean;
  refetch: () => Promise<void>;
}

export interface UseConversationStartersOptions {
  /** Override for {@link STARTERS_AWAIT_DEADLINE_MS}. */
  awaitDeadlineMs?: number;
}

const NOOP_REFETCH = async (): Promise<void> => {};

const IDLE_RESULT: UseConversationStartersResult = {
  starters: [],
  status: "idle",
  isLoading: false,
  isAwaitingStarters: false,
  refetch: NOOP_REFETCH,
};

export function useConversationStarters(
  assistantId: string | null | undefined,
  options?: UseConversationStartersOptions,
): UseConversationStartersResult {
  const enabled = Boolean(assistantId);
  const awaitDeadlineMs =
    options?.awaitDeadlineMs ?? STARTERS_AWAIT_DEADLINE_MS;

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

  // Expiry is keyed to the enabled query's identity and read synchronously,
  // so the first committed render after an assistant switch or a re-enable
  // can never wear the previous query's expired answer. A post-commit reset
  // would paint one frame with that stale answer, and for an assistant known
  // to produce starters that frame collapses the reserved dock and re-expands
  // it, moving the composer during the transition the reserve exists to hold
  // still. Same render-phase adjustment as `useAssistantProducedStartersAtOpen`.
  const awaitKey = enabled ? (assistantId ?? null) : null;
  const [awaitState, setAwaitState] = useState<{
    key: string | null;
    expired: boolean;
  }>(() => ({ key: awaitKey, expired: false }));
  if (awaitState.key !== awaitKey) {
    setAwaitState({ key: awaitKey, expired: false });
  }
  const awaitExpired = awaitState.key === awaitKey && awaitState.expired;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const key = assistantId ?? null;
    const timer = setTimeout(() => {
      setAwaitState((current) => {
        if (current.key !== key || current.expired) {
          return current;
        }
        return { key, expired: true };
      });
    }, awaitDeadlineMs);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, assistantId, awaitDeadlineMs]);

  if (!enabled) {
    return IDLE_RESULT;
  }

  const starters = query.data?.starters ?? [];
  const status = query.data?.status ?? "generating";
  // A paused fetch is the offline case: TanStack's default `networkMode`
  // holds the request without ever reporting a load or an error, so the
  // status stays on its pre-answer fallback and nothing else here would
  // ever end the wait.
  const paused = query.fetchStatus === "paused";

  return {
    starters,
    status,
    isLoading: query.isLoading,
    isAwaitingStarters:
      starters.length === 0 &&
      !query.isError &&
      !paused &&
      !awaitExpired &&
      (query.isLoading || status === "generating" || status === "refreshing"),
    refetch: async () => {
      await query.refetch();
    },
  };
}
