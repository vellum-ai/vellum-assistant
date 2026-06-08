/**
 * Pull-to-refresh hook — uses TanStack Query invalidation to refetch
 * conversation history. Replaces the old refreshSettleRef promise pattern
 * with a direct `invalidateQueries` call that resolves when the refetch
 * completes.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientinvalidatequeries
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { RefreshOutcome } from "@/domains/chat/transcript/transcript";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PULL_REFRESH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsePullRefreshParams {
  activeConversationId: string | null | undefined;
  /** Invalidate the TQ history cache and refetch. Resolves when the refetch completes. */
  invalidateHistory: () => Promise<void>;
  /** Also bump the conversation-list refresh epoch (non-history side-effects). */
  onRefreshEpoch: () => void;
}

interface UsePullRefreshReturn {
  refreshFeedback: RefreshOutcome | null;
  touchSupported: boolean;
  handlePullRefresh: () => Promise<RefreshOutcome>;
  handleDismissRefreshFeedback: () => void;
  handleRetryRefreshFromPill: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePullRefresh({
  activeConversationId,
  invalidateHistory,
  onRefreshEpoch,
}: UsePullRefreshParams): UsePullRefreshReturn {
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshOutcome | null>(null);
  const abortRef = useRef(false);

  // Resolve post-mount to keep SSR/hydration HTML in sync — the gesture
  // mounts a spinner element when enabled, so the initial render must
  // match the server's "false" assumption.
  const [touchSupported, setTouchSupported] = useState(false);
  useEffect(() => {
    setTouchSupported(isPointerCoarse());
  }, []);

  const handlePullRefresh = useCallback(async (): Promise<RefreshOutcome> => {
    const conversationId = activeConversationId;
    if (!conversationId) {
      return { kind: "no-change" };
    }

    abortRef.current = false;
    const beforeCount = useChatSessionStore.getState().messages.length;

    // Also refresh the conversation list.
    onRefreshEpoch();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("pull_refresh_timeout")),
        PULL_REFRESH_TIMEOUT_MS,
      );
    });

    try {
      // invalidateQueries returns a promise that resolves when all active
      // queries matching the filter are refetched. The data-apply effect
      // in useConversationHistory runs synchronously in the same React
      // commit cycle, so messagesRef is updated by the time we check.
      await Promise.race([invalidateHistory(), timeout]);

      // Yield one frame to let React commit the data-apply effect.
      await new Promise((r) => requestAnimationFrame(r));

      if (abortRef.current) {
        return { kind: "no-change" };
      }

      const afterCount = useChatSessionStore.getState().messages.length;
      const delta = afterCount - beforeCount;
      const outcome: RefreshOutcome =
        delta > 0
          ? { kind: "new-messages", count: delta }
          : { kind: "no-change" };

      if (outcome.kind === "new-messages") {
        void haptic.success();
      } else {
        void haptic.medium();
      }
      setRefreshFeedback(outcome);
      return outcome;
    } catch (err) {
      if (abortRef.current) {
        return { kind: "no-change" };
      }

      const errMessage = err instanceof Error ? err.message : "";
      const outcome: RefreshOutcome = {
        kind: "error",
        message: errMessage || undefined,
      };
      void haptic.error();
      setRefreshFeedback(outcome);
      return outcome;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }, [activeConversationId, invalidateHistory, onRefreshEpoch]);

  // Abort any in-flight pull-refresh when the active conversation changes.
  useEffect(() => {
    abortRef.current = true;
  }, [activeConversationId]);

  const handleDismissRefreshFeedback = useCallback(() => {
    setRefreshFeedback(null);
  }, []);

  const handleRetryRefreshFromPill = useCallback(() => {
    setRefreshFeedback(null);
    void handlePullRefresh();
  }, [handlePullRefresh]);

  return {
    refreshFeedback,
    touchSupported,
    handlePullRefresh,
    handleDismissRefreshFeedback,
    handleRetryRefreshFromPill,
  };
}
