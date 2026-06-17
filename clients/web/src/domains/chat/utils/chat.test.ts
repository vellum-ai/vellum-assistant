import { describe, expect, test } from "bun:test";

import {
  extractWirePendingConfirmation,
  hasAssistantMessage,
  shouldClearFirstMessageGateOnConversationChange,
} from "@/domains/chat/utils/chat";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";

function message(role: DisplayMessage["role"], id: string): DisplayMessage {
  return {
    id,
    role,
  };
}

function assistantWithToolCalls(
  id: string,
  toolCalls: ChatMessageToolCall[],
): DisplayMessage {
  return { id, role: "assistant", toolCalls };
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

  describe("extractWirePendingConfirmation", () => {
    test("projects a snapshot-carried prompt into interaction-store shape", () => {
      /**
       * On a cold reconnect the daemon stamps the outstanding prompt onto the
       * tool call; the FE must restore it to the interaction store and bind it
       * to the carrying tool call.
       */
      // GIVEN a history snapshot whose latest tool call carries a pending
      // confirmation
      const messages = [
        message("user", "user-1"),
        assistantWithToolCalls("assistant-1", [
          {
            id: "tool-1",
            name: "file_read",
            input: { path: "/home/user/project/a.txt" },
            pendingConfirmation: {
              requestId: "req-9",
              toolName: "file_read",
              riskLevel: "high",
            },
          },
        ]),
      ];

      // WHEN we extract the wire-carried confirmation
      const restored = extractWirePendingConfirmation(messages);

      // THEN the prompt is returned with toolUseId set to the carrying tool call
      expect(restored?.requestId).toBe("req-9");
      expect(restored?.toolName).toBe("file_read");
      expect(restored?.toolUseId).toBe("tool-1");
    });

    test("returns null when no tool call is awaiting a decision", () => {
      /**
       * A reopened conversation with only resolved tool calls must not
       * resurrect a confirmation prompt.
       */
      // GIVEN a snapshot whose tool calls carry no pending confirmation
      const messages = [
        assistantWithToolCalls("assistant-1", [
          { id: "tool-1", name: "file_read", input: {}, result: "ok" },
        ]),
      ];

      // WHEN we extract the wire-carried confirmation
      const restored = extractWirePendingConfirmation(messages);

      // THEN there is nothing to restore
      expect(restored).toBeNull();
    });
  });
});
