/**
 * Manages the lifecycle of the in-chat inbox-cleanup offer card.
 *
 * Phase transitions: `pending` → `visible` → `dismissed`.
 * The card becomes visible when all conditions are met (activation flag on,
 * did onboarding, the chosen first task is inbox-cleanup, greeting arrived,
 * on the onboarding conversation). Once dismissed it never reappears.
 *
 * Spike version: accept assumes Google is already connected and just runs the
 * inbox-cleanup skill (OAuth is layered in by a later PR).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

/**
 * Stable id of the inbox-cleanup first task. Mirrors `INBOX_CLEANUP_TASK_ID`
 * from `@/domains/onboarding/choose-first-task`; duplicated as a literal here
 * because the chat domain may not import from the onboarding domain
 * (`local/no-cross-domain-imports`). The page layer (active-chat-view) derives
 * `firstTask` from the real onboarding constant before passing it in.
 */
const INBOX_CLEANUP_TASK_ID = "inbox-cleanup";

/** Run message that matches the inbox-cleanup skill's activation hints. */
const INBOX_CLEANUP_RUN_MESSAGE =
  "Please clean up my inbox using the inbox-cleanup skill, then give me a concrete summary of how many emails you archived and by which pass.";

interface UseInboxCleanupOfferOptions {
  didOnboarding: boolean;
  firstTask: string | null;
  activationFlowEnabled: boolean;
  messages: DisplayMessage[];
  activeConversationId: string | null;
  onboardingConversationId: string | null;
  sendMessage: (content: string) => void;
}

interface UseInboxCleanupOfferReturn {
  showInboxOffer: boolean;
  handleAccept: () => void;
  handleDecline: () => void;
  accepting: boolean;
}

export function useInboxCleanupOffer({
  didOnboarding,
  firstTask,
  activationFlowEnabled,
  messages,
  activeConversationId,
  onboardingConversationId,
  sendMessage,
}: UseInboxCleanupOfferOptions): UseInboxCleanupOfferReturn {
  const [phase, setPhase] = useState<"pending" | "visible" | "dismissed">(
    "pending",
  );
  const [accepting, setAccepting] = useState(false);

  // Latch ref: once an assistant message is seen, skip the .some() scan on
  // subsequent renders. Only computed while phase === "pending".
  const greetingSeenRef = useRef(false);
  const greetingConversationIdRef = useRef<string | null>(null);

  // Reset the greeting latch when the conversation changes so an assistant
  // message in one thread can't satisfy the latch for a different thread.
  // Sync refs in the commit phase per React 19's useRef caveats.
  useLayoutEffect(() => {
    if (greetingConversationIdRef.current !== activeConversationId) {
      greetingConversationIdRef.current = activeConversationId;
      greetingSeenRef.current = false;
    }
    if (!greetingSeenRef.current && phase === "pending") {
      greetingSeenRef.current = messages.some((m) => m.role === "assistant");
    }
  });

  // Track the conversation id when the card became visible so we can
  // dismiss on conversation switch without racing the didOnboarding flag.
  const visibleConversationIdRef = useRef<string | null>(null);

  // Transition from pending -> visible when all conditions are met.
  useEffect(() => {
    if (
      phase === "pending" &&
      activationFlowEnabled &&
      didOnboarding &&
      firstTask === INBOX_CLEANUP_TASK_ID &&
      greetingSeenRef.current &&
      activeConversationId === onboardingConversationId
    ) {
      visibleConversationIdRef.current = activeConversationId;
      setPhase("visible");
    }
    // `messages` is not read in the body; listed so this effect re-fires
    // when a new message arrives and greetingSeenRef may have just latched.
  }, [phase, activationFlowEnabled, didOnboarding, firstTask, messages, activeConversationId, onboardingConversationId]);

  // Dismiss if the user switches to a different conversation.
  useEffect(() => {
    if (
      phase === "visible" &&
      visibleConversationIdRef.current !== null &&
      activeConversationId !== visibleConversationIdRef.current
    ) {
      setPhase("dismissed");
    }
  }, [phase, activeConversationId]);

  const dismiss = useCallback(() => {
    setPhase("dismissed");
  }, []);

  const handleDecline = useCallback(() => {
    dismiss();
  }, [dismiss]);

  const handleAccept = useCallback(() => {
    setAccepting(true);
    dismiss();
    sendMessage(INBOX_CLEANUP_RUN_MESSAGE);
  }, [dismiss, sendMessage]);

  return {
    showInboxOffer: phase === "visible",
    handleAccept,
    handleDecline,
    accepting,
  };
}
