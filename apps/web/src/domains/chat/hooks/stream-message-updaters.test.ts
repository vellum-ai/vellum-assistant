import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

import {
  appendTextDelta,
  applyToolProgress,
  applyToolResult,
  createStreamingBubble,
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
