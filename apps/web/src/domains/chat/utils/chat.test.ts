import { describe, expect, test } from "bun:test";

import {
  hasAssistantMessage,
  shouldClearFirstMessageGateOnConversationChange,
} from "@/domains/chat/utils/chat";
import type { DisplayMessage } from "@/domains/chat/types/types";

function message(role: DisplayMessage["role"], id: string): DisplayMessage {
  return {
    id,
    role,
  };
}

describe("chat utilities", () => {
  describe("hasAssistantMessage", () => {
    test("does not treat the user opener as an assistant response", () => {
      expect(hasAssistantMessage([message("user", "user-1")])).toBe(false);
    });

    test("detects when assistant output has started", () => {
      expect(
        hasAssistantMessage([
          message("user", "user-1"),
          message("assistant", "assistant-1"),
        ]),
      ).toBe(true);
    });
  });

  describe("shouldClearFirstMessageGateOnConversationChange", () => {
    test("does not clear on first mount", () => {
      expect(
        shouldClearFirstMessageGateOnConversationChange({
          previousConversationId: null,
          nextConversationId: "conv-1",
          onboardingDraftConversationId: "draft-1",
          autoGreetPending: true,
          assistantMessagePresent: false,
        }),
      ).toBe(false);
    });

    test("keeps the gate during onboarding draft handoff before assistant output", () => {
      expect(
        shouldClearFirstMessageGateOnConversationChange({
          previousConversationId: "draft-1",
          nextConversationId: "conv-1",
          onboardingDraftConversationId: "draft-1",
          autoGreetPending: true,
          assistantMessagePresent: false,
        }),
      ).toBe(false);
    });

    test("clears on normal conversation switches", () => {
      expect(
        shouldClearFirstMessageGateOnConversationChange({
          previousConversationId: "conv-1",
          nextConversationId: "conv-2",
          onboardingDraftConversationId: "draft-1",
          autoGreetPending: true,
          assistantMessagePresent: false,
        }),
      ).toBe(true);
    });

    test("clears once assistant output exists", () => {
      expect(
        shouldClearFirstMessageGateOnConversationChange({
          previousConversationId: "draft-1",
          nextConversationId: "conv-1",
          onboardingDraftConversationId: "draft-1",
          autoGreetPending: true,
          assistantMessagePresent: true,
        }),
      ).toBe(true);
    });
  });
});
