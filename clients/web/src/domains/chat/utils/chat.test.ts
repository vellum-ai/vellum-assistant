import { afterEach, describe, expect, test } from "bun:test";

import {
  attachConfirmationToToolCall,
  extractWirePendingAcpConnect,
  extractWirePendingConfirmation,
  extractWirePendingQuestion,
  formatVoiceError,
  hasAssistantMessage,
  isConversationScopedStreamEvent,
  shouldClearFirstMessageGateOnConversationChange,
} from "@/domains/chat/utils/chat";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  ACP_CLAUDE_OAUTH_MISSING_CODE,
} from "@/domains/chat/utils/acp-connect";
import type { AssistantEvent } from "@/types/event-types";
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

afterEach(() => {
  delete (window as unknown as { vellum?: unknown }).vellum;
});

describe("chat utilities", () => {
  describe("formatVoiceError", () => {
    test("names the Windows client in native dictation errors", () => {
      (
        window as unknown as {
          vellum?: { platform: "electron"; hostOS: "windows" };
        }
      ).vellum = { platform: "electron", hostOS: "windows" };

      expect(formatVoiceError("native-stt-no-transcript")).toBe(
        "Windows Native Dictation didn’t return a transcript. Check native speech recognition in system settings, then try again.",
      );
    });

    test("names the macOS client in native dictation errors", () => {
      (
        window as unknown as {
          vellum?: { platform: "electron"; hostOS: "macos" };
        }
      ).vellum = { platform: "electron", hostOS: "macos" };

      expect(formatVoiceError("native-stt-no-transcript")).toBe(
        "macOS Native Dictation didn’t return a transcript. Check native speech recognition in system settings, then try again.",
      );
    });
  });

  describe("isConversationScopedStreamEvent", () => {
    const scoped = (type: string) =>
      isConversationScopedStreamEvent({ type } as AssistantEvent);

    test("background-tool lifecycle events are global (not conversation-scoped)", () => {
      // A completion firing while the user views another conversation must still
      // reach the global background-task store, like the subagent/acp families.
      expect(scoped("background_tool_started")).toBe(false);
      expect(scoped("background_tool_completed")).toBe(false);
    });

    test("matches the subagent/acp global treatment", () => {
      expect(scoped("subagent_spawned")).toBe(false);
      expect(scoped("acp_session_completed")).toBe(false);
    });

    test("ordinary conversation events stay scoped", () => {
      expect(scoped("tool_output_chunk")).toBe(true);
    });

    test("open_url stays conversation-scoped (conversationless CLI emits are owned by useOpenUrlDirectives)", () => {
      // Making open_url global would let a background turn's browser
      // hand-off fire over an unrelated conversation. The conversationless
      // CLI variant is handled by the always-mounted root subscriber, not
      // by exempting the type here.
      expect(scoped("open_url")).toBe(true);
    });
  });

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

  describe("extractWirePendingQuestion", () => {
    test("projects a snapshot-carried question into interaction-store shape", () => {
      /**
       * The live `question_request` event can be missed (e.g. broadcast while
       * no SSE client was connected). On the next history load the daemon
       * stamps the outstanding prompt onto its tool call; the FE must restore
       * it to the interaction store so the card finally renders.
       */
      // GIVEN a history snapshot whose latest tool call carries a pending question
      const entries = [
        {
          id: "q1",
          question: "What's the email about?",
          options: [{ id: "a", label: "iOS app is live" }],
        },
      ];
      const messages = [
        message("user", "user-1"),
        assistantWithToolCalls("assistant-1", [
          {
            id: "tool-1",
            name: "ask_question",
            input: {},
            pendingQuestion: { requestId: "req-9", entries },
          },
        ]),
      ];

      // WHEN we extract the wire-carried question
      const restored = extractWirePendingQuestion(messages);

      // THEN the prompt is returned with toolUseId set to the carrying tool call
      expect(restored?.requestId).toBe("req-9");
      expect(restored?.entries).toEqual(entries);
      expect(restored?.toolUseId).toBe("tool-1");
    });

    test("returns null when no tool call is awaiting an answer", () => {
      // GIVEN a snapshot whose tool calls carry no pending question
      const messages = [
        assistantWithToolCalls("assistant-1", [
          { id: "tool-1", name: "ask_question", input: {}, result: "answered" },
        ]),
      ];

      // WHEN we extract the wire-carried question
      const restored = extractWirePendingQuestion(messages);

      // THEN there is nothing to restore
      expect(restored).toBeNull();
    });
  });

  describe("extractWirePendingAcpConnect", () => {
    test("restores the Connect card from a failed acp_spawn's persisted marker", () => {
      /**
       * The live `tool_result` tap raises the card once on arrival, but a full
       * reload / SSE reconnect rebuilds the store empty. On the next history
       * load the daemon carries the `acp_claude_oauth_missing` marker on the
       * failed tool call; the FE must re-raise the card so it doesn't vanish.
       */
      // GIVEN a snapshot whose acp_spawn tool call failed for a missing token
      const messages = [
        message("user", "user-1"),
        assistantWithToolCalls("assistant-1", [
          {
            id: "tool-1",
            name: "acp_spawn",
            input: { agent: "claude" },
            isError: true,
            errorCode: ACP_CLAUDE_OAUTH_MISSING_CODE,
          },
        ]),
      ];

      // WHEN we extract the wire-carried Connect prompt
      const restored = extractWirePendingAcpConnect(messages);

      // THEN it is anchored to the failed tool call so the card restores in place
      expect(restored?.toolUseId).toBe("tool-1");
    });

    test("restores a pre-spawn rejected-credential card with its reason", () => {
      // The auth_required marker persists on the failed tool call exactly like
      // the missing-token one, so this card survives reloads; the reason must
      // survive with it or the restored card self-dismisses on a
      // token-presence check.
      const messages = [
        assistantWithToolCalls("assistant-1", [
          {
            id: "tool-auth",
            name: "acp_spawn",
            input: { agent: "claude" },
            isError: true,
            errorCode: ACP_CLAUDE_AUTH_REQUIRED_CODE,
          },
        ]),
      ];

      expect(extractWirePendingAcpConnect(messages)).toEqual({
        toolUseId: "tool-auth",
        reason: "auth_required",
      });
    });

    test("returns the most recent failure when several are present", () => {
      // GIVEN two failed acp_spawn calls across the transcript
      const messages = [
        assistantWithToolCalls("assistant-1", [
          {
            id: "old-fail",
            name: "acp_spawn",
            input: { agent: "claude" },
            isError: true,
            errorCode: ACP_CLAUDE_OAUTH_MISSING_CODE,
          },
        ]),
        assistantWithToolCalls("assistant-2", [
          {
            id: "new-fail",
            name: "acp_spawn",
            input: { agent: "claude" },
            isError: true,
            errorCode: ACP_CLAUDE_OAUTH_MISSING_CODE,
          },
        ]),
      ];

      // WHEN we extract the wire-carried Connect prompt
      const restored = extractWirePendingAcpConnect(messages);

      // THEN the latest failure wins (scanned latest-first)
      expect(restored?.toolUseId).toBe("new-fail");
    });

    test("returns null when no tool call carries the missing-token marker", () => {
      // GIVEN a snapshot whose acp_spawn succeeded (no error marker)
      const messages = [
        assistantWithToolCalls("assistant-1", [
          {
            id: "tool-1",
            name: "acp_spawn",
            input: { agent: "claude" },
            result: "spawned",
          },
        ]),
      ];

      // WHEN we extract the wire-carried Connect prompt
      const restored = extractWirePendingAcpConnect(messages);

      // THEN there is nothing to restore
      expect(restored).toBeNull();
    });
  });
});

describe("attachConfirmationToToolCall", () => {
  const conf = {
    requestId: "req-1",
    toolName: "bash",
    input: { command: "ls" },
  };

  test("attaches to the tool call named by toolUseId", () => {
    const messages = [
      assistantWithToolCalls("m1", [
        { id: "tc-1", name: "bash", input: {} },
        { id: "tc-2", name: "file_read", input: {} },
      ]),
    ];

    const { updatedMessages, attachedToolCallId } =
      attachConfirmationToToolCall(messages, { ...conf, toolUseId: "tc-2" });

    expect(attachedToolCallId).toBe("tc-2");
    const attached = updatedMessages[0]!.toolCalls!.filter(
      (tc) => tc.pendingConfirmation?.requestId === "req-1",
    );
    // Exactly one call carries it: a prompt that lands on two chips renders
    // two approve/deny pairs for one decision.
    expect(attached.map((tc) => tc.id)).toEqual(["tc-2"]);
  });

  test("does not attach when the confirmation names no tool call, even with a running one present", () => {
    const messages = [
      assistantWithToolCalls("m1", [
        // Running: no result yet. The deleted fallback used to seize on this.
        { id: "tc-running", name: "bash", input: {} },
      ]),
    ];

    const { updatedMessages, attachedToolCallId } =
      attachConfirmationToToolCall(messages, conf);

    // An absent toolUseId means the daemon has no tool call for this prompt
    // (ACP route approvals). Guessing one hides the prompt whenever the guess
    // lands on a call the transcript does not draw; leaving it unattached
    // routes it to the trailer row instead.
    expect(attachedToolCallId).toBeUndefined();
    expect(
      updatedMessages.some((m) =>
        m.toolCalls?.some((tc) => tc.pendingConfirmation !== undefined),
      ),
    ).toBe(false);
  });

  test("does not attach when toolUseId names a call that is not present", () => {
    const messages = [
      assistantWithToolCalls("m1", [{ id: "tc-1", name: "bash", input: {} }]),
    ];

    const { attachedToolCallId } = attachConfirmationToToolCall(messages, {
      ...conf,
      toolUseId: "tc-absent",
    });

    expect(attachedToolCallId).toBeUndefined();
  });
});
