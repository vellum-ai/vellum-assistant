import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

import {
  MAX_STREAMED_OUTPUT_CHARS,
  appendToolOutputChunk,
  applyToolResult,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { textBody as seg } from "@/domains/chat/utils/message-test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userMsg: DisplayMessage = {
  id: "user-1",
  role: "user",
  ...seg("hi"),
  timestamp: 999,
};

function tc(
  id: string,
  over: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return { id, name: "bash", input: {}, startedAt: 1000, ...over };
}

function asstMsg(
  toolCalls: ChatMessageToolCall[],
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    id: "asst-1",
    role: "assistant",
    ...seg(""),
    timestamp: 1000,
    toolCalls,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appendToolOutputChunk
// ---------------------------------------------------------------------------

describe("appendToolOutputChunk", () => {
  it("appends a chunk onto the matching tool call by id", () => {
    const prev = [userMsg, asstMsg([tc("tc-1")])];
    const next = appendToolOutputChunk(prev, {
      chunk: "line 1\n",
      toolUseId: "tc-1",
    });
    expect(next[1]!.toolCalls![0]!.streamedOutput).toBe("line 1\n");
  });

  it("accumulates successive chunks", () => {
    let s = [userMsg, asstMsg([tc("tc-1")])];
    s = appendToolOutputChunk(s, { chunk: "a", toolUseId: "tc-1" });
    s = appendToolOutputChunk(s, { chunk: "b", toolUseId: "tc-1" });
    s = appendToolOutputChunk(s, { chunk: "c", toolUseId: "tc-1" });
    expect(s[1]!.toolCalls![0]!.streamedOutput).toBe("abc");
  });

  it("narrows to the messageId-owning row, beating the back-to-front scan", () => {
    // Two rows carry the same tool id (pathological); messageId picks the
    // earlier row, which a plain back-to-front scan would never reach first.
    const rowA = asstMsg([tc("tc-1")], { id: "row-A" });
    const rowB = asstMsg([tc("tc-1")], { id: "row-B" });
    const next = appendToolOutputChunk([userMsg, rowA, rowB], {
      chunk: "x",
      toolUseId: "tc-1",
      messageId: "row-A",
    });
    expect(next[1]!.toolCalls![0]!.streamedOutput).toBe("x");
    expect(next[2]!.toolCalls![0]!.streamedOutput).toBeUndefined();
  });

  it("does NOT positionally misattribute a chunk whose id is absent", () => {
    // A chunk for an unknown id (e.g. a switched-away conversation) must not
    // attach to some unrelated running tool — it is a no-op.
    const prev = [userMsg, asstMsg([tc("running-tc")])];
    const next = appendToolOutputChunk(prev, {
      chunk: "stray",
      toolUseId: "other-convo-tc",
    });
    expect(next).toBe(prev);
    expect(next[1]!.toolCalls![0]!.streamedOutput).toBeUndefined();
  });

  it("falls back to the last running tool call when no toolUseId (pre-anchor)", () => {
    const completed = tc("done", { result: "ok", completedAt: 2000 });
    const running = tc("live");
    const prev = [userMsg, asstMsg([completed, running])];
    const next = appendToolOutputChunk(prev, { chunk: "y" });
    expect(next[1]!.toolCalls![1]!.streamedOutput).toBe("y");
    expect(next[1]!.toolCalls![0]!.streamedOutput).toBeUndefined();
  });

  it("bounds the retained tail to MAX_STREAMED_OUTPUT_CHARS", () => {
    const prev = [userMsg, asstMsg([tc("tc-1")])];
    const big = "x".repeat(MAX_STREAMED_OUTPUT_CHARS + 500);
    const next = appendToolOutputChunk(prev, { chunk: big, toolUseId: "tc-1" });
    const out = next[1]!.toolCalls![0]!.streamedOutput!;
    expect(out.length).toBe(MAX_STREAMED_OUTPUT_CHARS);
    expect(out).toBe(big.slice(big.length - MAX_STREAMED_OUTPUT_CHARS));
  });

  it("ignores empty chunks", () => {
    const prev = [userMsg, asstMsg([tc("tc-1")])];
    expect(appendToolOutputChunk(prev, { chunk: "", toolUseId: "tc-1" })).toBe(
      prev,
    );
  });

  it("does not mutate the previous messages", () => {
    const prev = [userMsg, asstMsg([tc("tc-1")])];
    appendToolOutputChunk(prev, { chunk: "z", toolUseId: "tc-1" });
    expect(prev[1]!.toolCalls![0]!.streamedOutput).toBeUndefined();
  });

  it("keeps the streamed call reading as running (never sets result)", () => {
    const prev = [userMsg, asstMsg([tc("tc-1")])];
    const next = appendToolOutputChunk(prev, {
      chunk: "partial",
      toolUseId: "tc-1",
    });
    expect(isToolCallRunning(next[1]!.toolCalls![0]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult clears the live tail
// ---------------------------------------------------------------------------

describe("applyToolResult + streamedOutput", () => {
  it("drops the live tail when the final result lands", () => {
    let s = [userMsg, asstMsg([tc("tc-1")])];
    s = appendToolOutputChunk(s, { chunk: "streamed tail", toolUseId: "tc-1" });
    expect(s[1]!.toolCalls![0]!.streamedOutput).toBe("streamed tail");

    s = applyToolResult(s, { toolUseId: "tc-1", result: "final output" });
    expect(s[1]!.toolCalls![0]!.result).toBe("final output");
    expect(s[1]!.toolCalls![0]!.streamedOutput).toBeUndefined();
  });
});
