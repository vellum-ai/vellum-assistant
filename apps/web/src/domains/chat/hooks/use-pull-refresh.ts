
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";

import type { RefreshOutcome } from "@/domains/chat/transcript/transcript.js";

import { haptic } from "@/utils/haptics.js";
import { isPointerCoarse } from "@/utils/pointer.js";

// ---------------------------------------------------------------------------
// Sentinel errors — distinguish silent aborts from real failures
// ---------------------------------------------------------------------------

const PULL_REFRESH_SUPERSEDED = "pull_refresh_superseded";
const PULL_REFRESH_CONVERSATION_CHANGED = "pull_refresh_conversation_changed";

const PULL_REFRESH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshSettleHandle {
  resolve: () => void;
  reject: (err: unknown) => void;
  conversationKey: string;
}

interface UsePullRefreshParams {
  activeConversationKey: string | null | undefined;
  messagesRef: MutableRefObject<{ length: number }>;
  onRefreshConversation: () => void;
  refreshSettleRef?: MutableRefObject<RefreshSettleHandle | null>;
}

interface UsePullRefreshReturn {
  refreshSettleRef: MutableRefObject<RefreshSettleHandle | null>;
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
  activeConversationKey,
  messagesRef,
  onRefreshConversation,
  refreshSettleRef: externalRefreshSettleRef,
}: UsePullRefreshParams): UsePullRefreshReturn {
  const internalRefreshSettleRef = useRef<RefreshSettleHandle | null>(null);
  const refreshSettleRef = externalRefreshSettleRef ?? internalRefreshSettleRef;
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshOutcome | null>(null);

  // Resolve post-mount to keep SSR/hydration HTML in sync — the gesture
  // mounts a spinner element when enabled, so the initial render must
  // match the server's "false" assumption.
  const [touchSupported, setTouchSupported] = useState(false);
  useEffect(() => {
    setTouchSupported(isPointerCoarse());
  }, []);

  const handlePullRefresh = useCallback(async (): Promise<RefreshOutcome> => {
    const conversationKey = activeConversationKey;
    if (!conversationKey) {
      return { kind: "no-change" };
    }

    const beforeCount = messagesRef.current.length;

    // Supersede any prior in-flight settle handle.
    if (refreshSettleRef.current) {
      const prior = refreshSettleRef.current;
      refreshSettleRef.current = null;
      prior.reject(new Error(PULL_REFRESH_SUPERSEDED));
    }

    const settled = new Promise<void>((resolve, reject) => {
      refreshSettleRef.current = { resolve, reject, conversationKey };
    });

    onRefreshConversation();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("pull_refresh_timeout")),
        PULL_REFRESH_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([settled, timeout]);
      const afterCount = messagesRef.current.length;
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
      const errMessage = err instanceof Error ? err.message : "";
      const isSilentAbort =
        errMessage === PULL_REFRESH_SUPERSEDED ||
        errMessage === PULL_REFRESH_CONVERSATION_CHANGED;

      if (isSilentAbort) {
        return { kind: "no-change" };
      }

      const outcome: RefreshOutcome = {
        kind: "error",
        message: errMessage || undefined,
      };
      void haptic.error();
      setRefreshFeedback(outcome);
      return outcome;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (refreshSettleRef.current) {
        refreshSettleRef.current = null;
      }
    }
  }, [activeConversationKey, messagesRef, onRefreshConversation]);

  // Abort any in-flight pull-refresh when the active conversation changes.
  useEffect(() => {
    const settle = refreshSettleRef.current;
    if (settle && settle.conversationKey !== activeConversationKey) {
      refreshSettleRef.current = null;
      settle.reject(new Error(PULL_REFRESH_CONVERSATION_CHANGED));
    }
  }, [activeConversationKey]);

  const handleDismissRefreshFeedback = useCallback(() => {
    setRefreshFeedback(null);
  }, []);

  const handleRetryRefreshFromPill = useCallback(() => {
    setRefreshFeedback(null);
    void handlePullRefresh();
  }, [handlePullRefresh]);

  return {
    refreshSettleRef,
    refreshFeedback,
    touchSupported,
    handlePullRefresh,
    handleDismissRefreshFeedback,
    handleRetryRefreshFromPill,
  };
}
