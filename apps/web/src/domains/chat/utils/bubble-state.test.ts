import { describe, expect, it } from "bun:test";

import {
  assistantBubbleIsActive,
  computeNeedsNewBubble,
} from "@/domains/chat/utils/bubble-state.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

function makeAssistant(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    stableId: "stable-1",
    role: "assistant",
    content: "",
    timestamp: 1000,
    ...overrides,
  };
}

const userMsg: DisplayMessage = {
  stableId: "user-1",
  role: "user",
  content: "hi",
  timestamp: 999,
};

describe("assistantBubbleIsActive", () => {
  it("returns false for undefined", () => {
    expect(assistantBubbleIsActive(undefined)).toBe(false);
  });

  it("returns false for non-assistant messages", () => {
    expect(assistantBubbleIsActive(userMsg)).toBe(false);
  });

  it("returns true when isStreaming is set", () => {
    expect(
      assistantBubbleIsActive(makeAssistant({ isStreaming: true })),
    ).toBe(true);
  });

  it("returns true when isStreaming is not set but a tool call is running", () => {
    expect(
      assistantBubbleIsActive(
        makeAssistant({
          isStreaming: false,
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "running",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("returns false when isStreaming is cleared and all tool calls completed", () => {
    expect(
      assistantBubbleIsActive(
        makeAssistant({
          isStreaming: false,
          toolCalls: [
            {
              id: "tc-1",
              toolName: "bash",
              input: {},
              status: "completed",
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("computeNeedsNewBubble", () => {
  it("needs a new bubble for an empty transcript", () => {
    expect(computeNeedsNewBubble([])).toBe(true);
  });

  it("needs a new bubble when the last row is a user message", () => {
    expect(computeNeedsNewBubble([userMsg])).toBe(true);
  });

  it("does not need a new bubble when the last assistant row is streaming", () => {
    expect(
      computeNeedsNewBubble([userMsg, makeAssistant({ isStreaming: true })]),
    ).toBe(false);
  });

  // Regression for the mid-turn bubble split bug. Even when a stale history
  // snapshot has cleared `isStreaming`, an in-flight tool call means the
  // assistant turn is still active and the next `tool_use_start` must NOT
  // open a fresh bubble below the message's timestamp footer.
  it("does not need a new bubble when the last assistant row still has running tools", () => {
    const stillStreamingByTool = makeAssistant({
      isStreaming: false,
      toolCalls: [
        {
          id: "tc-1",
          toolName: "bash",
          input: {},
          status: "running",
        },
      ],
    });
    expect(computeNeedsNewBubble([userMsg, stillStreamingByTool])).toBe(false);
  });

  it("needs a new bubble when the last assistant row has fully finalized", () => {
    const finalized = makeAssistant({
      isStreaming: false,
      toolCalls: [
        {
          id: "tc-1",
          toolName: "bash",
          input: {},
          status: "completed",
        },
      ],
    });
    expect(computeNeedsNewBubble([userMsg, finalized])).toBe(true);
  });
});
