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
 * 2. **Messages-arrived clear** — once the first message appears, the gate
 *    drops immediately.
 * 3. **Safety timer** — a 10-second backstop prevents the user from being
 *    stranded on the overlay if auto-send or greeting fails.
 * 4. **Conversation-switch clear** — switching away from the hatched
 *    conversation dismisses the gate (auto-greet is system-wide, not
 *    per-conversation).
 */

import { useEffect, useRef } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

export function useAutoGreetGate(
  activeConversationId: string | null,
  hasPendingPreChatMessage: boolean,
): boolean {
  const autoGreetPending =
    useAssistantLifecycleStore.use.expectingFirstMessage();
  const messages = useChatSessionStore.use.messages();

  // 1. Pre-chat sessionStorage detector — re-arm gate on reload.
  useEffect(() => {
    if (hasPendingPreChatMessage) {
      lifecycleService.markExpectingFirstMessage();
    }
  }, [hasPendingPreChatMessage]);

  // 2. Clear gate once the first message appears.
  useEffect(() => {
    if (!autoGreetPending) return;
    if (messages.length > 0) lifecycleService.clearExpectingFirstMessage();
  }, [autoGreetPending, messages.length]);

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
  // to a different conversation after first mount. Draft → real ID
  // handoff also trips this, but by then the messages-arrived effect
  // has already dismissed the gate, so the second dismiss is a no-op.
  const lastSeenConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeConversationId == null) return;
    const previous = lastSeenConvIdRef.current;
    lastSeenConvIdRef.current = activeConversationId;
    if (previous != null && previous !== activeConversationId) {
      lifecycleService.clearExpectingFirstMessage();
    }
  }, [activeConversationId]);

  return autoGreetPending;
}
