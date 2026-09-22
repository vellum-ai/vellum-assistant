import { useCallback, useEffect, useState } from "react";

interface SessionDisclosureVisitState {
  conversationId: string | null;
  observedLiveSessionIds: ReadonlySet<string>;
  explicitChoices: ReadonlyMap<string, boolean>;
}

export interface SessionDisclosureState {
  isSessionOpen: (sessionId: string) => boolean;
  isSessionExplicitlyClosed?: (sessionId: string) => boolean;
  observeLiveSession: (sessionId: string) => void;
  setSessionOpen: (sessionId: string, open: boolean) => void;
}

function emptyVisitState(
  conversationId: string | null,
): SessionDisclosureVisitState {
  return {
    conversationId,
    observedLiveSessionIds: new Set(),
    explicitChoices: new Map(),
  };
}

/**
 * Owns disclosure choices for one conversation visit. Mount this beside the
 * active conversation identity, above transcript surfaces that can remount.
 */
export function useSessionDisclosureState(
  conversationId: string | null,
  enabled = true,
): SessionDisclosureState {
  const activeConversationId = enabled ? conversationId : null;
  const [visit, setVisit] = useState<SessionDisclosureVisitState>(() =>
    emptyVisitState(activeConversationId),
  );

  useEffect(() => {
    setVisit((current) =>
      current.conversationId === activeConversationId
        ? current
        : emptyVisitState(activeConversationId),
    );
  }, [activeConversationId]);

  const observeLiveSession = useCallback(
    (sessionId: string) => {
      if (!activeConversationId || sessionId.length === 0) {
        return;
      }
      setVisit((current) => {
        if (
          current.conversationId !== activeConversationId ||
          current.observedLiveSessionIds.has(sessionId)
        ) {
          return current;
        }
        return {
          ...current,
          observedLiveSessionIds: new Set([
            ...current.observedLiveSessionIds,
            sessionId,
          ]),
        };
      });
    },
    [activeConversationId],
  );

  const setSessionOpen = useCallback(
    (sessionId: string, open: boolean) => {
      if (!activeConversationId || sessionId.length === 0) {
        return;
      }
      setVisit((current) => {
        if (current.conversationId !== activeConversationId) {
          return current;
        }
        if (current.explicitChoices.get(sessionId) === open) {
          return current;
        }
        const explicitChoices = new Map(current.explicitChoices);
        explicitChoices.set(sessionId, open);
        return { ...current, explicitChoices };
      });
    },
    [activeConversationId],
  );

  const isSessionOpen = useCallback(
    (sessionId: string): boolean => {
      if (
        visit.conversationId !== activeConversationId ||
        sessionId.length === 0
      ) {
        return false;
      }
      const explicitChoice = visit.explicitChoices.get(sessionId);
      return explicitChoice ?? visit.observedLiveSessionIds.has(sessionId);
    },
    [activeConversationId, visit],
  );

  const isSessionExplicitlyClosed = useCallback(
    (sessionId: string): boolean =>
      visit.conversationId === activeConversationId &&
      visit.explicitChoices.get(sessionId) === false,
    [activeConversationId, visit],
  );

  return {
    isSessionOpen,
    isSessionExplicitlyClosed,
    observeLiveSession,
    setSessionOpen,
  };
}
