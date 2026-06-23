import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { ToolOutputChunkEvent } from "@vellumai/assistant-api";

import {
  MAX_STREAMED_OUTPUT_CHARS,
  appendToolOutputChunk,
  applyToolResult,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import {
  flushToolOutput,
  handleToolOutputChunk,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";
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

// ---------------------------------------------------------------------------
// flushToolOutput / handleToolOutputChunk (coalescing)
// ---------------------------------------------------------------------------

function makeCtx(initial: DisplayMessage[]) {
  let messages = initial;
  const ctx = {
    toolOutputBufferRef: {
      current: new Map<string, { messageId?: string; text: string }>(),
    },
    toolOutputFlushHandleRef: { current: null as number | null },
    setMessages: (
      updater:
        | DisplayMessage[]
        | ((prev: DisplayMessage[]) => DisplayMessage[]),
    ) => {
      messages =
        typeof updater === "function"
          ? (updater as (p: DisplayMessage[]) => DisplayMessage[])(messages)
          : updater;
    },
  } as unknown as StreamHandlerContext;
  return { ctx, get: () => messages };
}

describe("flushToolOutput", () => {
  it("drains buffered chunks for multiple tools in one pass", () => {
    const { ctx, get } = makeCtx([userMsg, asstMsg([tc("a"), tc("b")])]);
    ctx.toolOutputBufferRef.current.set("a", { text: "AA" });
    ctx.toolOutputBufferRef.current.set("b", { text: "BB" });
    flushToolOutput(ctx);
    expect(get()[1]!.toolCalls![0]!.streamedOutput).toBe("AA");
    expect(get()[1]!.toolCalls![1]!.streamedOutput).toBe("BB");
    expect(ctx.toolOutputBufferRef.current.size).toBe(0);
  });

  it("is a no-op when the buffer is empty", () => {
    const { ctx, get } = makeCtx([userMsg, asstMsg([tc("a")])]);
    const before = get();
    flushToolOutput(ctx);
    expect(get()).toBe(before);
  });
});

describe("handleToolOutputChunk", () => {
  let scheduled: Array<() => void>;
  let cancelled: Set<number>;
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    scheduled = [];
    cancelled = new Set();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      scheduled.push(() => cb(0));
      return scheduled.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      cancelled.add(id);
    }) as typeof globalThis.cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  });

  function runScheduled() {
    const cbs = scheduled.slice();
    scheduled = [];
    cbs.forEach((cb, i) => {
      if (!cancelled.has(i + 1)) cb();
    });
  }

  const ev = (chunk: string): ToolOutputChunkEvent =>
    ({ type: "tool_output_chunk", chunk, toolUseId: "tc-1" }) as ToolOutputChunkEvent;

  it("coalesces multiple chunks into a single flush", () => {
    const { ctx, get } = makeCtx([userMsg, asstMsg([tc("tc-1")])]);
    handleToolOutputChunk(ev("a"), ctx);
    handleToolOutputChunk(ev("b"), ctx);
    handleToolOutputChunk(ev("c"), ctx);
    // One frame scheduled (coalesced); nothing applied to state yet.
    expect(scheduled.length).toBe(1);
    expect(get()[1]!.toolCalls![0]!.streamedOutput).toBeUndefined();

    runScheduled();
    expect(get()[1]!.toolCalls![0]!.streamedOutput).toBe("abc");
  });

  it("schedules no frame for an empty chunk", () => {
    const { ctx } = makeCtx([userMsg, asstMsg([tc("tc-1")])]);
    handleToolOutputChunk(
      { type: "tool_output_chunk", chunk: "", toolUseId: "tc-1" } as ToolOutputChunkEvent,
      ctx,
    );
    expect(scheduled.length).toBe(0);
  });
});
