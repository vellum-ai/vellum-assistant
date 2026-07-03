/**
 * Owns the post-hatch "Connecting…" overlay lifecycle.
 *
 * When the assistant is freshly hatched, `expectingFirstMessage` is set
 * in `useAssistantLifecycleStore` by every hatch path. This hook
 * consolidates the gate-clearing logic:
 *
 * 1. **Pre-chat sessionStorage detector** — if a pending pre-chat context
 *    exists on mount (e.g. after a page reload mid-flow), re-arm the gate
 *    so the auto-send hook can fire without the user seeing the raw chat UI.
 * 2. **Assistant-output clear** — once assistant output appears, the gate
 *    drops immediately.
 * 3. **Safety timer** — a 30-second backstop surfaces a retry prompt
 *    if auto-send or greeting fails, instead of silently dismissing.
 * 4. **Conversation-switch clear** — switching away from the hatched
 *    conversation dismisses the gate, except for the onboarding draft→real
 *    conversation handoff while assistant output is still pending.
 */

import { useEffect, useRef, useState } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  hasAssistantMessage,
  shouldClearFirstMessageGateOnConversationChange,
} from "@/domains/chat/utils/chat";

export interface AutoGreetGateResult {
  show: boolean;
  timedOut: boolean;
}

export function useAutoGreetGate(
  activeConversationId: string | null,
  hasPendingPreChatMessage: boolean,
  onboardingDraftConversationId: string | null,
): AutoGreetGateResult {
  const autoGreetPending =
    useAssistantLifecycleStore.use.expectingFirstMessage();
  // The post-hatch greeting folds into the materialized snapshot as it streams;
  // a freshly hatched conversation has no persisted history yet, so the snapshot
  // is the right (and sufficient) place to watch for the first assistant message.
  const snapshot = useChatSessionStore.use.snapshot();
  const firstAssistantMessageArrived = hasAssistantMessage(snapshot?.messages);
  const [timedOut, setTimedOut] = useState(false);

  // 1. Pre-chat sessionStorage detector — re-arm gate on reload.
  useEffect(() => {
    if (hasPendingPreChatMessage) {
      lifecycleService.markExpectingFirstMessage();
    }
  }, [hasPendingPreChatMessage]);

  // 2. Clear gate once assistant output appears.
  useEffect(() => {
    if (!autoGreetPending) return;
    if (firstAssistantMessageArrived) {
      setTimedOut(false);
      lifecycleService.clearExpectingFirstMessage();
    }
  }, [autoGreetPending, firstAssistantMessageArrived]);

  // 3. Safety timer — 30s backstop. Surfaces a retry prompt instead
  // of silently dismissing the overlay.
  useEffect(() => {
    if (!autoGreetPending) {
      setTimedOut(false);
      return;
    }
    const timeout = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timeout);
  }, [autoGreetPending]);

  // 4. Conversation-switch clear — dismiss gate when the user navigates
  // to a different conversation after first mount, but preserve it across
  // onboarding draft → real conversation handoff until assistant output exists.
  const lastSeenConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeConversationId == null) return;
    const previous = lastSeenConvIdRef.current;
    lastSeenConvIdRef.current = activeConversationId;
    if (
      shouldClearFirstMessageGateOnConversationChange({
        previousConversationId: previous,
        nextConversationId: activeConversationId,
        onboardingDraftConversationId,
        autoGreetPending,
        assistantMessagePresent: firstAssistantMessageArrived,
      })
    ) {
      lifecycleService.clearExpectingFirstMessage();
    }
  }, [
    activeConversationId,
    autoGreetPending,
    firstAssistantMessageArrived,
    onboardingDraftConversationId,
  ]);

  return { show: autoGreetPending, timedOut };
}
