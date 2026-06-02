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
 * 3. **Safety timer** — a 10-second backstop prevents the user from being
 *    stranded on the overlay if auto-send or greeting fails.
 * 4. **Conversation-switch clear** — switching away from the hatched
 *    conversation dismisses the gate, except for the onboarding draft→real
 *    conversation handoff while assistant output is still pending.
 */

import { useEffect, useRef } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  hasAssistantMessage,
  shouldClearFirstMessageGateOnConversationChange,
} from "@/domains/chat/utils/chat";

export function useAutoGreetGate(
  activeConversationId: string | null,
  hasPendingPreChatMessage: boolean,
  onboardingDraftConversationId: string | null,
): boolean {
  const autoGreetPending =
    useAssistantLifecycleStore.use.expectingFirstMessage();
  const messages = useChatSessionStore.use.messages();
  const firstAssistantMessageArrived = hasAssistantMessage(messages);

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
      lifecycleService.clearExpectingFirstMessage();
    }
  }, [autoGreetPending, firstAssistantMessageArrived]);

  // 3. Safety timer — 10s backstop.
  useEffect(() => {
    if (!autoGreetPending) return;
    const timeout = setTimeout(
      () => lifecycleService.clearExpectingFirstMessage(),
      10_000,
    );
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

  return autoGreetPending;
}
