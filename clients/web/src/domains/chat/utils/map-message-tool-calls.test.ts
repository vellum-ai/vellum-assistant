import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";

function toolCall(
  overrides: Partial<ChatMessageToolCall> & Pick<ChatMessageToolCall, "id">,
): ChatMessageToolCall {
  return {
    name: "bash",
    input: {},
    ...overrides,
  };
}

function assistantMessage(
  toolCalls: ChatMessageToolCall[],
): DisplayMessage {
  return {
    id: "msg-1",
    role: "assistant",
    toolCalls,
    contentBlocks: toolCalls.map((tc) => ({ type: "tool_use", toolCall: tc })),
  };
}

describe("mapMessageToolCalls", () => {
  test("patches the matching tool_use block in lockstep with toolCalls", () => {
    /**
     * A transform that mutates a tool call must update both the positional
     * `toolCalls` entry and the `tool_use` block carrying the same id, since
     * the transcript renders straight off the blocks.
     */

    // GIVEN an assistant message whose tool call has a pending confirmation
    const pending = { requestId: "req-1" };
    const message = assistantMessage([
      toolCall({ id: "call-a", pendingConfirmation: pending }),
      toolCall({ id: "call-b" }),
    ]);

    // WHEN the pending confirmation is cleared from call-a
    const next = mapMessageToolCalls(message, (tc) =>
      tc.id === "call-a" ? { ...tc, pendingConfirmation: undefined } : tc,
    );

    // THEN both the positional tool call and its block reflect the change
    expect(next.toolCalls?.[0]?.pendingConfirmation).toBeUndefined();
    const blockA = next.contentBlocks?.find(
      (b) => b.type === "tool_use" && b.toolCall.id === "call-a",
    );
    expect(blockA?.type).toBe("tool_use");
    expect(
      blockA?.type === "tool_use"
        ? blockA.toolCall.pendingConfirmation
        : "unset",
    ).toBeUndefined();

    // AND the untouched tool call keeps its block reference (stable identity)
    const blockB = next.contentBlocks?.find(
      (b) => b.type === "tool_use" && b.toolCall.id === "call-b",
    );
    expect(blockB).toBe(message.contentBlocks?.[1]);
  });

  test("returns the same message reference when no tool call changes", () => {
    /**
     * Callers rely on identity-based change detection, so a no-op transform
     * must return the original message untouched.
     */

    // GIVEN an assistant message with tool calls
    const message = assistantMessage([toolCall({ id: "call-a" })]);

    // WHEN a transform leaves every tool call unchanged
    const next = mapMessageToolCalls(message, (tc) => tc);

    // THEN the same reference is returned
    expect(next).toBe(message);
  });

  test("is a no-op for messages without tool calls", () => {
    /**
     * User rows and text-only assistant rows carry no tool calls; the helper
     * must pass them through verbatim.
     */

    // GIVEN a user message with no tool calls
    const message: DisplayMessage = {
      id: "msg-1",
      role: "user",
      textSegments: ["hi"],
    };

    // WHEN the helper runs
    const next = mapMessageToolCalls(message, (tc) => ({ ...tc, isError: true }));

    // THEN the message is returned untouched
    expect(next).toBe(message);
  });

  test("patches toolCalls even when no contentBlocks projection exists", () => {
    /**
     * Some rows (pre-blocks daemons, partial fixtures) carry positional
     * `toolCalls` without `contentBlocks`. The positional array must still be
     * patched, leaving `contentBlocks` undefined.
     */

    // GIVEN an assistant message with toolCalls but no contentBlocks
    const message: DisplayMessage = {
      id: "msg-1",
      role: "assistant",
      toolCalls: [toolCall({ id: "call-a" })],
    };

    // WHEN a tool call is marked errored
    const next = mapMessageToolCalls(message, (tc) => ({
      ...tc,
      isError: true,
    }));

    // THEN the positional tool call is updated and contentBlocks stays absent
    expect(next.toolCalls?.[0]?.isError).toBe(true);
    expect(next.contentBlocks).toBeUndefined();
  });
});
