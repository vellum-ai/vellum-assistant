/**
 * Manages the lifecycle of the in-chat onboarding choice card.
 *
 * Phase transitions: `pending` → `visible` → `dismissed`.
 * The card becomes visible when all conditions are met (native, did onboarding,
 * greeting arrived, no tasks selected during prechat). Once dismissed it never
 * reappears.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";

interface UseOnboardingChoiceOptions {
  isNative: boolean;
  didOnboarding: boolean;
  messages: DisplayMessage[];
  onboardingTasksEmpty: boolean;
  activeConversationId: string | null;
  onboardingConversationId: string | null;
  sendMessage: (content: string) => void;
}

interface UseOnboardingChoiceReturn {
  showOnboardingChoice: boolean;
  handleSelectSpecific: () => void;
  handleSubmitTasks: (tasks: Set<string>, customText?: string) => void;
  dismiss: () => void;
}

export function useOnboardingChoice({
  isNative,
  didOnboarding,
  messages,
  onboardingTasksEmpty,
  activeConversationId,
  onboardingConversationId,
  sendMessage,
}: UseOnboardingChoiceOptions): UseOnboardingChoiceReturn {
  const [phase, setPhase] = useState<"pending" | "visible" | "dismissed">(
    "pending",
  );

  // Latch ref: once an assistant message is seen, skip the .some() scan on
  // subsequent renders. Only computed while phase === "pending".
  const greetingSeenRef = useRef(false);
  const greetingConversationIdRef = useRef<string | null>(null);

  // Reset the greeting latch when the conversation changes so an assistant
  // message in one thread can't satisfy the latch for a different thread.
  if (greetingConversationIdRef.current !== activeConversationId) {
    greetingConversationIdRef.current = activeConversationId;
    greetingSeenRef.current = false;
  }

  if (!greetingSeenRef.current && phase === "pending") {
    greetingSeenRef.current = messages.some((m) => m.role === "assistant");
  }

  // Track the conversation id when the card became visible so we can
  // dismiss on conversation switch without racing the didOnboarding flag.
  const visibleConversationIdRef = useRef<string | null>(null);

  // Transition from pending -> visible when all conditions are met.
  useEffect(() => {
    if (
      phase === "pending" &&
      isNative &&
      didOnboarding &&
      greetingSeenRef.current &&
      onboardingTasksEmpty &&
      activeConversationId === onboardingConversationId
    ) {
      visibleConversationIdRef.current = activeConversationId;
      setPhase("visible");
    }
    // `messages` is not read in the body; listed so this effect re-fires
    // when a new message arrives and greetingSeenRef may have just latched.
  }, [phase, isNative, didOnboarding, messages, onboardingTasksEmpty, activeConversationId, onboardingConversationId]);

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

  const handleSelectSpecific = useCallback(() => {
    sendMessage("I have something specific in mind");
    dismiss();
  }, [sendMessage, dismiss]);

  const handleSubmitTasks = useCallback(
    (tasks: Set<string>, customText?: string) => {
      const labels = PRECHAT_TASKS.filter((t) => tasks.has(t.id)).map(
        (t) => `${t.label} (${t.sublabel})`,
      );
      if (customText) {
        labels.push(customText);
      }
      const message = `I'm most interested in help with: ${labels.join(", ")}`;
      sendMessage(message);
      dismiss();
    },
    [sendMessage, dismiss],
  );

  return {
    showOnboardingChoice: phase === "visible",
    handleSelectSpecific,
    handleSubmitTasks,
    dismiss,
  };
}
