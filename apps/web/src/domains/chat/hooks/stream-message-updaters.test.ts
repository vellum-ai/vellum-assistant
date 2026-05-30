import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

import {
  appendTextDelta,
  applyToolResult,
  attachSurface,
  createStreamingBubble,
  finalizeMessageComplete,
  finalizeOnIdle,
  handleConversationError,
  stopStreaming,
  upsertToolCall,
} from "@/domains/chat/hooks/stream-message-updaters";
import type { Surface } from "@/domains/chat/types/types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

function makeAssistantMsg(
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    id: "stable-1",
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
  id: "user-1",
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
    expect(bubble.id).toBeDefined();
  });

  it("works on an empty array", () => {
    const result = createStreamingBubble([], "text");
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.isStreaming).toBe(true);
  });

  it("preserves existing messages", () => {
    const existing = [userMsg, makeAssistantMsg({ id: "a1" })];
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

  it("creates a new streaming bubble when last message is a finalized assistant", () => {
    // Old behavior was a no-op; new behavior opens a fresh bubble so the
    // text-delta isn't dropped on the floor. This is the bubble-creation
    // path that used to be gated by `needsNewBubbleRef`.
    const finalized = makeAssistantMsg({ isStreaming: false });
    const result = appendTextDelta([userMsg, finalized], "text");

    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe("assistant");
    expect(result[2]!.isStreaming).toBe(true);
    expect(result[2]!.content).toBe("text");
  });

  it("creates a new streaming bubble when last message is a user message", () => {
    // Initial assistant turn (no prior assistant bubble at all) — first
    // text delta must spawn the bubble rather than no-op.
    const result = appendTextDelta([userMsg], "text");

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.isStreaming).toBe(true);
    expect(result[1]!.content).toBe("text");
  });

  it("uses the supplied messageId when creating a new bubble", () => {
    const result = appendTextDelta([userMsg], "text", "msg-xyz");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("msg-xyz");
  });

  it("does not mutate the original array", () => {
    const msg = makeAssistantMsg({ content: "a" });
    const prev = [msg];
    appendTextDelta(prev, "b");
    expect(prev[0]!.content).toBe("a");
  });

  it("extends the matching row when messageId matches, regardless of tail position", () => {
    // B3 invariant — every event in an LLM call carries the same
    // `messageId`. The handler must land deltas in the row keyed by id,
    // not the tail. This covers the reconcile race that produced the
    // duplicate-row screenshot: a poll fetched the daemon's reserved row
    // (empty content, no `isStreaming` flag) into local state ahead of
    // the first delta. Before B5 the tail check returned false on the
    // snapshot row and `createStreamingBubble` pushed a NEW row with the
    // same id — two siblings, both with id=row-X.
    const reservedFromReconcile = makeAssistantMsg({
      id: "row-X",
      content: "",
      textSegments: [],
      contentOrder: [],
      isStreaming: false,
    });
    const result = appendTextDelta(
      [userMsg, reservedFromReconcile],
      "Hello",
      "row-X",
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-X");
    expect(result[1]!.content).toBe("Hello");
    expect(result[1]!.isStreaming).toBe(true);
    expect(result[1]!.textSegments).toEqual([{ type: "text", content: "Hello" }]);
  });

  it("opens a new bubble when messageId is provided but no row matches", () => {
    // Boundary between LLM calls in the same turn: call 1 was finalized
    // by `message_complete` (`isStreaming: false`), call 2's first delta
    // arrives with a new messageId. The fresh delta MUST open a new
    // bubble, not extend the finalized one.
    const call1Final = makeAssistantMsg({
      id: "row-A",
      content: "Hello",
      textSegments: [{ type: "text", content: "Hello" }],
      contentOrder: [{ type: "text", id: "0" }],
      isStreaming: false,
    });
    const result = appendTextDelta([userMsg, call1Final], " world", "row-B");

    expect(result).toHaveLength(3);
    expect(result[2]!.id).toBe("row-B");
    expect(result[2]!.content).toBe(" world");
    expect(result[2]!.isStreaming).toBe(true);
    // Original row untouched.
    expect(result[1]!.id).toBe("row-A");
    expect(result[1]!.content).toBe("Hello");
  });

  it("extends consecutive same-id deltas into a single row", () => {
    // The common case: a single LLM call emits N deltas, all carrying
    // the same `messageId`. They accumulate into one row.
    let state: DisplayMessage[] = [userMsg];
    state = appendTextDelta(state, "Hello", "row-A");
    state = appendTextDelta(state, " ", "row-A");
    state = appendTextDelta(state, "world", "row-A");

    expect(state).toHaveLength(2);
    expect(state[1]!.id).toBe("row-A");
    expect(state[1]!.content).toBe("Hello world");
  });

});

// ---------------------------------------------------------------------------
// finalizeMessageComplete
// ---------------------------------------------------------------------------

describe("finalizeMessageComplete", () => {
  // `message_complete` carries no body content on the wire — text streams via
  // `assistant_text_delta` chunks; `message_complete` only finalizes/binds.
  // The "new bubble" branch fires only when attachments accompany the event.

  it("opens a new finalized assistant bubble with attachments when tail is a user message", () => {
    const result = finalizeMessageComplete([userMsg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          data: "JVBERi0=",
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.id).toBe("row-A");
    expect(result[1]!.content).toBe("");
    expect(result[1]!.attachments).toHaveLength(1);
    expect(result[1]!.isStreaming).toBeUndefined();
  });

  it("opens a new bubble with attachments when prev is empty", () => {
    const result = finalizeMessageComplete([], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          data: "JVBERi0=",
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("row-A");
    expect(result[0]!.attachments).toHaveLength(1);
  });

  it("returns prev unchanged when tail is user and event has no attachments", () => {
    const prev = [userMsg];
    const result = finalizeMessageComplete(prev, {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
    });
    expect(result).toBe(prev);
  });

  it("finalizes a streaming assistant tail and keeps tail.id (anchor preservation)", () => {
    const msg = makeAssistantMsg({ id: "bubble-anchor", content: "hello world" });
    const result = finalizeMessageComplete([userMsg, msg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "inner-row-id",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("bubble-anchor");
    expect(result[1]!.isStreaming).toBe(false);
    // Bubble content stays whatever the text-delta accumulator left it as —
    // message_complete no longer carries body content on the wire.
    expect(result[1]!.content).toBe("hello world");
  });

  it("finalizes running tool calls when finalizing", () => {
    const toolCall: ChatMessageToolCall = {
      id: "t-1",
      toolName: "bash",
      input: { command: "ls" },
      status: "running",
    };
    const msg = makeAssistantMsg({ id: "bubble-A", toolCalls: [toolCall] });
    const result = finalizeMessageComplete([msg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-B",
    });
    expect(result[0]!.toolCalls?.[0]!.status).toBe("completed");
  });

  it("appends to a finalized assistant tail without overwriting its id (multi-LLM-call turn)", () => {
    // Second message_complete in the same agent turn — tail is the bubble
    // from the previous call (isStreaming already false). Should keep id.
    const tail = makeAssistantMsg({
      id: "bubble-anchor",
      content: "first call done",
      isStreaming: false,
    });
    const result = finalizeMessageComplete([userMsg, tail], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-B",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("bubble-anchor");
    // Tail content preserved across multi-call merge — message_complete no
    // longer brings its own content.
    expect(result[1]!.content).toBe("first call done");
  });

  it("adopts the server messageId for an optimistic streaming tail (first message_complete)", () => {
    // The live streaming bubble is created optimistic (text deltas carry no
    // messageId). The first message_complete must swap its client UUID for the
    // server id so the post-turn reconcile matches by id — otherwise a
    // multi-LLM-call turn (e.g. subagent spawn) whose collapsed server content
    // diverges from the bubble text reconciles to a duplicate row.
    const optimistic = makeAssistantMsg({
      id: "client-uuid",
      content: "Spawning a researcher on this now.",
      isOptimistic: true,
    });
    const result = finalizeMessageComplete([userMsg, optimistic], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "server-row-id",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-row-id");
    expect(result[1]!.isOptimistic).toBe(false);
    expect(result[1]!.isStreaming).toBe(false);
  });

  it("keeps the optimistic id when message_complete carries no messageId", () => {
    const optimistic = makeAssistantMsg({
      id: "client-uuid",
      isOptimistic: true,
    });
    const result = finalizeMessageComplete([userMsg, optimistic], {
      type: "message_complete",
      conversationId: "c-1",
    });

    expect(result[1]!.id).toBe("client-uuid");
    expect(result[1]!.isOptimistic).toBe(true);
    expect(result[1]!.isStreaming).toBe(false);
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

  it("keeps tail.id — never stamps a different id onto the bubble", () => {
    const msg = makeAssistantMsg({ id: "bubble-anchor" });
    const result = stopStreaming([msg]);
    expect(result[0]!.id).toBe("bubble-anchor");
    expect(result[0]!.isStreaming).toBe(false);
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

  it("appends tool call to existing streaming assistant tail", () => {
    const msg = makeAssistantMsg({ toolCalls: undefined });
    const result = upsertToolCall([userMsg, msg], toolCall);

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
    const result = upsertToolCall([msg], updatedTc);

    expect(result[0]!.toolCalls).toHaveLength(1);
    expect(result[0]!.toolCalls![0]!.toolName).toBe("web_search");
  });

  it("creates a new bubble when the tail is a finalized assistant", () => {
    // Finalized assistant tail (isStreaming: false) → derivation says
    // "open a fresh bubble" rather than extend the previous turn.
    const finalized = makeAssistantMsg({ isStreaming: false });
    const result = upsertToolCall([userMsg, finalized], toolCall);

    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe("assistant");
    expect(result[2]!.isStreaming).toBe(true);
    expect(result[2]!.toolCalls).toHaveLength(1);
  });

  it("creates a new bubble when no streaming assistant tail exists", () => {
    const result = upsertToolCall([userMsg], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("does not mutate existing messages", () => {
    const msg = makeAssistantMsg({ toolCalls: [] });
    const prev = [msg];
    upsertToolCall(prev, toolCall);
    expect(prev[0]!.toolCalls).toHaveLength(0);
  });

  it("folds into an id-matched assistant row when messageId is present", () => {
    // Reserved-row case: `assistant_turn_start` (or reconcile) landed an
    // empty assistant row at the anchor id ahead of the first
    // `tool_use_start`. Without id matching, upsertToolCall would open a
    // duplicate bubble.
    const anchor = makeAssistantMsg({
      id: "anchor-1",
      content: "",
      isStreaming: false,
      toolCalls: undefined,
      contentOrder: undefined,
    });
    const result = upsertToolCall([userMsg, anchor], toolCall, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("anchor-1");
    expect(result[1]!.isStreaming).toBe(true);
    expect(result[1]!.toolCalls).toHaveLength(1);
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("adopts messageId as the row id when opening a new bubble (no isOptimistic flag)", () => {
    // Anchor protocol: every `tool_use_start` carries `messageId` from
    // event zero — the daemon has committed to the assistant message
    // existing. The new bubble adopts that id and is NOT optimistic.
    const result = upsertToolCall([userMsg], toolCall, "server-msg-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-msg-1");
    expect(result[1]!.isOptimistic).toBeUndefined();
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("stamps isOptimistic only when messageId is absent (pre-anchor daemon)", () => {
    // Fallback path — only reachable from pre-B2 daemons that haven't
    // adopted the anchor protocol. The row id is a client UUID and the
    // flag tells reconcile to fall back to content matching.
    const result = upsertToolCall([userMsg], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.isOptimistic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attachSurface
// ---------------------------------------------------------------------------

describe("attachSurface", () => {
  const surface: Surface = {
    surfaceId: "surf-1",
    surfaceType: "card",
    data: {},
  };

  it("attaches to an id-matched assistant row when messageId is present", () => {
    const target = makeAssistantMsg({ id: "anchor-1", isStreaming: false });
    const result = attachSurface([userMsg, target], surface, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("anchor-1");
    expect(result[1]!.surfaces).toHaveLength(1);
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("falls back to the streaming-assistant tail when messageId is absent", () => {
    const target = makeAssistantMsg({ id: "stream-1", isStreaming: true });
    const result = attachSurface([userMsg, target], surface);

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("stream-1");
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("adopts messageId as the row id when opening a new bubble (no isOptimistic flag)", () => {
    // Surface-only turn: no streaming assistant yet, but the daemon
    // stamps the wire event with the anchor messageId.
    const result = attachSurface([userMsg], surface, "server-msg-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-msg-1");
    expect(result[1]!.isOptimistic).toBeUndefined();
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("stamps isOptimistic only when messageId is absent (pre-anchor daemon)", () => {
    const result = attachSurface([userMsg], surface);

    expect(result).toHaveLength(2);
    expect(result[1]!.isOptimistic).toBe(true);
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("is a no-op when the surface is already attached to the target message", () => {
    const target = makeAssistantMsg({
      id: "anchor-1",
      surfaces: [surface],
      contentOrder: [{ type: "surface", id: "surf-1" }],
    });
    const result = attachSurface([userMsg, target], surface, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.surfaces).toHaveLength(1);
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
// finalizeOnIdle — multi-message coverage
// ---------------------------------------------------------------------------

describe("finalizeOnIdle", () => {
  it("finalizes running tool calls across ALL streaming assistant messages", () => {
    const msg1 = makeAssistantMsg({
      id: "a1",
      content: "",
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
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

  it("flips isStreaming to false even when streaming messages have no running tool calls", () => {
    // New behavior (replaces what `needsNewBubbleRef` used to carry): the
    // tail must transition out of "streaming" state on idle regardless of
    // tool-call presence, so the next chunk derives "open a new bubble".
    const msg = makeAssistantMsg({
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "completed" },
      ],
    });
    const result = finalizeOnIdle([msg]);

    expect(result).toHaveLength(1);
    expect(result[0]!.isStreaming).toBe(false);
    // Already-completed tool calls remain untouched.
    expect(result[0]!.toolCalls![0]!.status).toBe("completed");
  });

  it("flips isStreaming to false on a streaming assistant with no tool calls at all", () => {
    const msg = makeAssistantMsg({ toolCalls: undefined });
    const result = finalizeOnIdle([msg]);

    expect(result).toHaveLength(1);
    expect(result[0]!.isStreaming).toBe(false);
  });

  it("does not modify non-streaming assistant messages", () => {
    const finishedMsg = makeAssistantMsg({
      id: "a-done",
      isStreaming: false,
      toolCalls: [
        { id: "tc-old", toolName: "bash", input: {}, status: "running" },
      ],
    });
    const streamingMsg = makeAssistantMsg({
      id: "a-stream",
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
      id: "a1",
      content: "",
      toolCalls: [
        { id: "tc-early", toolName: "web_search", input: {}, status: "running" },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-early" }],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
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
      id: "a1",
      content: "",
      toolCalls: [
        { id: "tc-1", toolName: "web_search", input: {}, status: "running" },
      ],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
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
