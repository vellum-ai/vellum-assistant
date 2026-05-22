import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

import {
  appendTextDelta,
  applyToolProgress,
  applyToolResult,
  createStreamingBubble,
  finalizeOnIdle,
  handleConversationError,
  stopStreaming,
  upsertToolCall,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";

function makeAssistantMsg(
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    stableId: "stable-1",
    role: "assistant",
    content: "hello",
    isStreaming: true,
    textSegments: [{ type: "text", content: "hello" }],
    contentOrder: [{ type: "text", id: "0" }],
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

// ---------------------------------------------------------------------------
// createStreamingBubble
// ---------------------------------------------------------------------------

describe("createStreamingBubble", () => {
  it("appends a new streaming assistant message", () => {
    const prev = [userMsg];
    const result = createStreamingBubble(prev, "Hello", "msg-1");

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(userMsg);

    const bubble = result[1]!;
    expect(bubble.role).toBe("assistant");
    expect(bubble.isStreaming).toBe(true);
    expect(bubble.content).toBe("Hello");
    expect(bubble.id).toBe("msg-1");
    expect(bubble.stableId).toBeDefined();
  });

  it("works on an empty array", () => {
    const result = createStreamingBubble([], "text");
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.isStreaming).toBe(true);
  });

  it("preserves existing messages", () => {
    const existing = [userMsg, makeAssistantMsg({ stableId: "a1" })];
    const result = createStreamingBubble(existing, "new");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(userMsg);
  });
});

// ---------------------------------------------------------------------------
// appendTextDelta
// ---------------------------------------------------------------------------

describe("appendTextDelta", () => {
  it("appends text to the last streaming assistant message", () => {
    const msg = makeAssistantMsg({ content: "He" });
    const result = appendTextDelta([userMsg, msg], "llo");

    expect(result).toHaveLength(2);
    const last = result[1]!;
    expect(last.content).toBe("Hello");
  });

  it("returns prev unchanged if last message is not streaming assistant", () => {
    const msg = makeAssistantMsg({ isStreaming: false });
    const prev = [userMsg, msg];
    const result = appendTextDelta(prev, "text");
    expect(result).toBe(prev);
  });

  it("returns prev unchanged if last message is a user message", () => {
    const prev = [userMsg];
    const result = appendTextDelta(prev, "text");
    expect(result).toBe(prev);
  });

  it("does not mutate the original array", () => {
    const msg = makeAssistantMsg({ content: "a" });
    const prev = [msg];
    appendTextDelta(prev, "b");
    expect(prev[0]!.content).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// stopStreaming
// ---------------------------------------------------------------------------

describe("stopStreaming", () => {
  it("sets isStreaming to false on the last assistant message", () => {
    const msg = makeAssistantMsg();
    const result = stopStreaming([userMsg, msg]);

    expect(result).toHaveLength(2);
    expect(result[1]!.isStreaming).toBe(false);
    expect(result[1]!.content).toBe("hello");
  });

  it("returns prev unchanged if last is not streaming", () => {
    const msg = makeAssistantMsg({ isStreaming: false });
    const prev = [msg];
    const result = stopStreaming(prev);
    expect(result).toBe(prev);
  });

  it("applies optional displayMessageId and rowMessageId", () => {
    const msg = makeAssistantMsg();
    const result = stopStreaming([msg], {
      displayMessageId: "d-1",
      rowMessageId: "r-1",
    });
    expect(result[0]!.id).toBe("d-1");
    expect(result[0]!.daemonMessageId).toBe("r-1");
  });
});

// ---------------------------------------------------------------------------
// handleConversationError
// ---------------------------------------------------------------------------

describe("handleConversationError", () => {
  it("finalizes streaming and keeps message with content", () => {
    const msg = makeAssistantMsg({ content: "partial response" });
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(2);
    expect(result[1]!.isStreaming).toBe(false);
    expect(result[1]!.content).toBe("partial response");
  });

  it("removes empty streaming bubble", () => {
    const msg = makeAssistantMsg({ content: "", toolCalls: undefined });
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(userMsg);
  });

  it("keeps message with tool calls but no text content", () => {
    const msg = makeAssistantMsg({
      content: "",
      toolCalls: [
        {
          id: "tc-1",
          toolName: "search",
          input: {},
          status: "running",
        },
      ],
    });
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(2);
    expect(result[1]!.isStreaming).toBe(false);
    expect(result[1]!.toolCalls![0]!.status).toBe("completed");
  });

  it("returns prev unchanged if last is not streaming assistant", () => {
    const prev = [userMsg];
    const result = handleConversationError(prev);
    expect(result).toBe(prev);
  });
});

// ---------------------------------------------------------------------------
// upsertToolCall
// ---------------------------------------------------------------------------

describe("upsertToolCall", () => {
  const toolCall = {
    id: "tc-1",
    toolName: "web_search",
    input: {} as Record<string, unknown>,
    status: "running" as const,
  };

  it("appends tool call to existing streaming message", () => {
    const msg = makeAssistantMsg({ toolCalls: undefined });
    const result = upsertToolCall([userMsg, msg], toolCall, false);

    expect(result).toHaveLength(2);
    expect(result[1]!.toolCalls).toHaveLength(1);
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
    expect(result[1]!.toolCalls![0]!.toolName).toBe("web_search");
  });

  it("updates existing tool call by id", () => {
    const msg = makeAssistantMsg({
      toolCalls: [{ id: "tc-1", toolName: "old_name", input: {}, status: "running" as const }],
    });
    const updatedTc = { id: "tc-1", toolName: "web_search", input: {} as Record<string, unknown>, status: "running" as const };
    const result = upsertToolCall([msg], updatedTc, false);

    expect(result[0]!.toolCalls).toHaveLength(1);
    expect(result[0]!.toolCalls![0]!.toolName).toBe("web_search");
  });

  it("creates new bubble when shouldCreateNewBubble is true", () => {
    const msg = makeAssistantMsg();
    const result = upsertToolCall([userMsg, msg], toolCall, true);

    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe("assistant");
    expect(result[2]!.isStreaming).toBe(true);
    expect(result[2]!.toolCalls).toHaveLength(1);
  });

  it("creates new bubble when no streaming assistant message exists", () => {
    const result = upsertToolCall([userMsg], toolCall, false);

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("does not mutate existing messages", () => {
    const msg = makeAssistantMsg({ toolCalls: [] });
    const prev = [msg];
    upsertToolCall(prev, toolCall, false);
    expect(prev[0]!.toolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — activityMetadata persistence
// ---------------------------------------------------------------------------

describe("applyToolResult — activityMetadata", () => {
  const baseToolCall: ChatMessageToolCall = {
    id: "tc-1",
    toolName: "web_search",
    input: { query: "tigers" },
    status: "running",
    startedAt: 1000,
  };

  function msgWithRunningCall(): DisplayMessage {
    return makeAssistantMsg({
      toolCalls: [baseToolCall],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
  }

  const metadata: ToolActivityMetadata = {
    webSearch: {
      query: "tigers",
      provider: "anthropic-native",
      resultCount: 1,
      durationMs: 250,
      results: [
        {
          rank: 1,
          title: "Tigers - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Tiger",
          domain: "en.wikipedia.org",
        },
      ],
    },
  };

  it("persists activityMetadata onto the tool call", () => {
    const result = applyToolResult([msgWithRunningCall()], {
      toolUseId: "tc-1",
      result: "...",
      activityMetadata: metadata,
    });
    expect(result[0]!.toolCalls![0]!.activityMetadata).toEqual(metadata);
    expect(result[0]!.toolCalls![0]!.status).toBe("completed");
  });

  it("preserves prior activityMetadata when re-applied without it", () => {
    const msg = makeAssistantMsg({
      toolCalls: [{ ...baseToolCall, status: "running", activityMetadata: metadata }],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const result = applyToolResult([msg], {
      toolUseId: "tc-1",
      result: "...",
    });
    expect(result[0]!.toolCalls![0]!.activityMetadata).toEqual(metadata);
  });
});

// ---------------------------------------------------------------------------
// applyToolProgress
// ---------------------------------------------------------------------------

describe("applyToolProgress", () => {
  const runningToolCall: ChatMessageToolCall = {
    id: "tc-1",
    toolName: "bash",
    input: {},
    status: "running",
    startedAt: 1000,
  };

  function msgWithRunning(): DisplayMessage {
    return makeAssistantMsg({
      toolCalls: [runningToolCall],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
  }

  it("stamps progressElapsedSec/progressTimeoutSec/lastProgressAt on matching tool call", () => {
    const result = applyToolProgress([msgWithRunning()], {
      toolUseId: "tc-1",
      elapsedSec: 15,
      timeoutSec: 60,
    });
    const tc = result[0]!.toolCalls![0]!;
    expect(tc.progressElapsedSec).toBe(15);
    expect(tc.progressTimeoutSec).toBe(60);
    expect(typeof tc.lastProgressAt).toBe("number");
  });

  it("falls back to the last running tool call when toolUseId is missing", () => {
    const result = applyToolProgress([msgWithRunning()], {
      elapsedSec: 10,
      timeoutSec: 30,
    });
    expect(result[0]!.toolCalls![0]!.progressElapsedSec).toBe(10);
  });

  it("is a no-op when no message with tool calls exists", () => {
    const prev = [userMsg];
    const result = applyToolProgress(prev, {
      toolUseId: "tc-1",
      elapsedSec: 5,
      timeoutSec: 30,
    });
    expect(result).toBe(prev);
  });

  it("is a no-op when the matching tool call isn't running", () => {
    const completed: ChatMessageToolCall = {
      ...runningToolCall,
      status: "completed",
    };
    const msg = makeAssistantMsg({
      toolCalls: [completed],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const result = applyToolProgress([msg], {
      toolUseId: "tc-1",
      elapsedSec: 5,
      timeoutSec: 30,
    });
    expect(result[0]!.toolCalls![0]!.progressElapsedSec).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// finalizeOnIdle — multi-message coverage
// ---------------------------------------------------------------------------

describe("finalizeOnIdle", () => {
  it("finalizes running tool calls across ALL streaming assistant messages", () => {
    const msg1 = makeAssistantMsg({
      stableId: "a1",
      content: "",
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const msg2 = makeAssistantMsg({
      stableId: "a2",
      content: "some text",
      toolCalls: [
        { id: "tc-2", toolName: "web_fetch", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-2" }],
    });
    const result = finalizeOnIdle([userMsg, msg1, msg2]);

    expect(result).toHaveLength(3);
    expect(result[1]!.toolCalls![0]!.status).toBe("completed");
    expect(result[1]!.toolCalls![0]!.completedAt).toBeDefined();
    expect(result[2]!.toolCalls![0]!.status).toBe("completed");
    expect(result[2]!.toolCalls![0]!.completedAt).toBeDefined();
  });

  it("returns prev unchanged when no streaming assistant messages exist", () => {
    const prev = [userMsg];
    const result = finalizeOnIdle(prev);
    expect(result).toBe(prev);
  });

  it("returns prev unchanged when streaming messages have no running tool calls", () => {
    const msg = makeAssistantMsg({
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "completed" },
      ],
    });
    const prev = [msg];
    const result = finalizeOnIdle(prev);
    expect(result).toBe(prev);
  });

  it("does not modify non-streaming assistant messages", () => {
    const finishedMsg = makeAssistantMsg({
      stableId: "a-done",
      isStreaming: false,
      toolCalls: [
        { id: "tc-old", toolName: "bash", input: {}, status: "running" },
      ],
    });
    const streamingMsg = makeAssistantMsg({
      stableId: "a-stream",
      toolCalls: [
        { id: "tc-new", toolName: "web_search", input: {}, status: "running" },
      ],
    });
    const result = finalizeOnIdle([finishedMsg, streamingMsg]);

    // The non-streaming message's tool call should remain "running"
    expect(result[0]!.toolCalls![0]!.status).toBe("running");
    // The streaming message's tool call should be finalized
    expect(result[1]!.toolCalls![0]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — cross-message matching
// ---------------------------------------------------------------------------

describe("applyToolResult — cross-message matching", () => {
  it("finds the tool call on an earlier message when toolUseId is provided", () => {
    // Simulate: tool_use_start on msg1, then a new bubble was created (msg2),
    // then tool_result arrives with toolUseId pointing to msg1's tool call.
    const msg1 = makeAssistantMsg({
      stableId: "a1",
      content: "",
      toolCalls: [
        { id: "tc-early", toolName: "web_search", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-early" }],
    });
    const msg2 = makeAssistantMsg({
      stableId: "a2",
      content: "some later text",
      toolCalls: [
        { id: "tc-later", toolName: "bash", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-later" }],
    });
    const result = applyToolResult([userMsg, msg1, msg2], {
      toolUseId: "tc-early",
      result: "search results",
    });

    // msg1's tool call should be completed
    expect(result[1]!.toolCalls![0]!.status).toBe("completed");
    expect(result[1]!.toolCalls![0]!.result).toBe("search results");
    // msg2's tool call should remain running
    expect(result[2]!.toolCalls![0]!.status).toBe("running");
  });

  it("falls back to last assistant message when toolUseId is not provided", () => {
    const msg1 = makeAssistantMsg({
      stableId: "a1",
      content: "",
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "running" },
      ],
    });
    const msg2 = makeAssistantMsg({
      stableId: "a2",
      content: "",
      toolCalls: [
        { id: "tc-2", toolName: "bash", input: {}, status: "running" },
      ],
    });
    const result = applyToolResult([userMsg, msg1, msg2], {
      result: "done",
    });

    // Without toolUseId, falls back to the last assistant message's last running tool call
    expect(result[1]!.toolCalls![0]!.status).toBe("running");
    expect(result[2]!.toolCalls![0]!.status).toBe("completed");
  });

  it("falls back to last running tool call when toolUseId does not match any message", () => {
    const msg = makeAssistantMsg({
      toolCalls: [
        { id: "tc-1", toolName: "bash", input: {}, status: "running" },
      ],
    });
    const result = applyToolResult([msg], {
      toolUseId: "nonexistent-id",
      result: "done",
    });

    // Should fall back and complete the last running tool call
    expect(result[0]!.toolCalls![0]!.status).toBe("completed");
  });
});
