/**
 * Manages the lifecycle of the in-chat onboarding choice card.
 *
 * Phase transitions: `pending` → `visible` → `dismissed`.
 * The card becomes visible when all conditions are met (native, did onboarding,
 * greeting arrived, no tasks selected during prechat). Once dismissed it never
 * reappears.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { PRECHAT_TASKS } from "@/types/prechat-tasks.js";

interface UseOnboardingChoiceOptions {
  isNative: boolean;
  didOnboarding: boolean;
  messages: DisplayMessage[];
  onboardingTasksEmpty: boolean;
  activeConversationKey: string | null;
  onboardingConversationKey: string | null;
  sendMessage: (content: string) => void;
}

interface UseOnboardingChoiceReturn {
  showOnboardingChoice: boolean;
  handleSubmitTasks: (tasks: Set<string>, customText?: string) => void;
  dismiss: () => void;
}

export function useOnboardingChoice({
  isNative,
  didOnboarding,
  messages,
  onboardingTasksEmpty,
  activeConversationKey,
  onboardingConversationKey,
  sendMessage,
}: UseOnboardingChoiceOptions): UseOnboardingChoiceReturn {
  const [phase, setPhase] = useState<"pending" | "visible" | "dismissed">(
    "pending",
  );

  // Latch ref: once an assistant message is seen, skip the .some() scan on
  // subsequent renders. Only computed while phase === "pending".
  const greetingSeenRef = useRef(false);
  const greetingConversationKeyRef = useRef<string | null>(null);

  // Reset the greeting latch when the conversation changes so an assistant
  // message in one thread can't satisfy the latch for a different thread.
  if (greetingConversationKeyRef.current !== activeConversationKey) {
    greetingConversationKeyRef.current = activeConversationKey;
    greetingSeenRef.current = false;
  }

  if (!greetingSeenRef.current && phase === "pending") {
    greetingSeenRef.current = messages.some((m) => m.role === "assistant");
  }

  // Track the conversation key when the card became visible so we can
  // dismiss on conversation switch without racing the didOnboarding flag.
  const visibleConversationKeyRef = useRef<string | null>(null);

  // Transition from pending -> visible when all conditions are met.
  useEffect(() => {
    if (
      phase === "pending" &&
      isNative &&
      didOnboarding &&
      greetingSeenRef.current &&
      onboardingTasksEmpty &&
      activeConversationKey === onboardingConversationKey
    ) {
      visibleConversationKeyRef.current = activeConversationKey;
      setPhase("visible");
    }
    // `messages` is not read in the body; listed so this effect re-fires
    // when a new message arrives and greetingSeenRef may have just latched.
  }, [phase, isNative, didOnboarding, messages, onboardingTasksEmpty, activeConversationKey, onboardingConversationKey]);

  // Dismiss if the user switches to a different conversation.
  useEffect(() => {
    if (
      phase === "visible" &&
      visibleConversationKeyRef.current !== null &&
      activeConversationKey !== visibleConversationKeyRef.current
    ) {
      setPhase("dismissed");
    }
  }, [phase, activeConversationKey]);

  const dismiss = useCallback(() => {
    setPhase("dismissed");
  }, []);

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
    handleSubmitTasks,
    dismiss,
  };
}
