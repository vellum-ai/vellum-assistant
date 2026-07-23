import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";

import { useOnboardingChoice } from "./use-onboarding-choice";

afterEach(() => {
  cleanup();
});

const CONVERSATION_ID = "conv-1";

const greeting: DisplayMessage[] = [{ id: "m1", role: "assistant" }];

/** All conditions satisfied for the card to show; tests override per-case. */
function baseOptions() {
  return {
    isNative: true,
    didOnboarding: true,
    messages: greeting,
    onboardingChoiceEligible: true,
    activeConversationId: CONVERSATION_ID,
    onboardingConversationId: CONVERSATION_ID,
    sendMessage: mock(() => {}),
  };
}

describe("useOnboardingChoice", () => {
  test("shows the card when all conditions are met", () => {
    const { result } = renderHook(() => useOnboardingChoice(baseOptions()));
    expect(result.current.showOnboardingChoice).toBe(true);
  });

  test("suppresses the card for ineligible handoffs (tasks selected or hidden kickoff)", () => {
    const { result } = renderHook(() =>
      useOnboardingChoice({ ...baseOptions(), onboardingChoiceEligible: false }),
    );
    expect(result.current.showOnboardingChoice).toBe(false);
  });
});
