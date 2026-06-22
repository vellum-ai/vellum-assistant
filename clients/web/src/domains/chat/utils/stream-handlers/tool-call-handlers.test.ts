import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleToolResult,
  handleToolUseStart,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";

describe("handleToolUseStart", () => {
  it("cancels reconciliation and creates tool call with generated id", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      { type: "tool_use_start", toolName: "web_search", input: { query: "test" } },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.onToolUseStart).toHaveBeenCalled();
    expect(ctx.toolCallIdCounterRef.current).toBe(1);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("uses provided toolUseId when available", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "custom-id",
      },
      ctx,
    );
    expect(ctx.toolCallIdCounterRef.current).toBe(0);
  });

  it("creates a new bubble when there is no assistant tail to fold into", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      { type: "tool_use_start", toolName: "web_search", input: {}, toolUseId: "tc-1" },
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalled();
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>).mock.calls[0][0] as (
      prev: never[],
    ) => Array<{ role: string; toolCalls: Array<{ id: string }> }>;
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0]?.role).toBe("assistant");
    expect(next[0]?.toolCalls).toHaveLength(1);
    expect(next[0]?.toolCalls[0]?.id).toBe("tc-1");
  });

  it("forwards event.messageId to the new bubble (adopts as row id, no isOptimistic)", () => {
    // Anchor protocol: tool_use_start carries messageId from event zero —
    // the daemon has committed to the assistant message existing. The new
    // bubble adopts that id rather than being stamped optimistic.
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-1",
        messageId: "server-msg-1",
      },
      ctx,
    );
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>).mock.calls[0][0] as (
      prev: never[],
    ) => Array<{ id: string; isOptimistic?: boolean }>;
    const next = updater([]);
    expect(next[0]?.id).toBe("server-msg-1");
    expect(next[0]?.isOptimistic).toBeUndefined();
  });

  it("folds three sequential tool_use_starts with the same messageId into one bubble", () => {
    // Concrete reproduction of the bug behind the screenshot: three
    // tool_use_starts arriving back-to-back with the same anchor messageId
    // must produce ONE assistant row with three tool calls, not three
    // overlapping bubbles or a duplicate.
    const ctx = makeCtx();
    let current: Array<{ id: string; toolCalls?: Array<{ id: string }>; isOptimistic?: boolean }> = [];
    const setMessages = ctx.setMessages as unknown as { mock: { calls: unknown[][] } };

    for (const [i, toolUseId] of ["tc-1", "tc-2", "tc-3"].entries()) {
      handleToolUseStart(
        {
          type: "tool_use_start",
          toolName: "web_search",
          input: {},
          toolUseId,
          messageId: "anchor-1",
        },
        ctx,
      );
      const updater = setMessages.mock.calls[i]![0] as (
        prev: typeof current,
      ) => typeof current;
      current = updater(current);
    }

    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe("anchor-1");
    expect(current[0]!.isOptimistic).toBeUndefined();
    expect(current[0]!.toolCalls).toHaveLength(3);
    expect(current[0]!.toolCalls!.map((tc) => tc.id)).toEqual(["tc-1", "tc-2", "tc-3"]);
  });
});

describe("handleToolResult", () => {
  it("dispatches TOOL_RESULT and updates messages", () => {
    const ctx = makeCtx();
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "Found 3 results",
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.turnActions.onToolResult).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("routes activityMetadata to onToolActivityMetadata action when present", () => {
    const ctx = makeCtx();
    const metadata = {
      webSearch: {
        query: "tigers",
        provider: "anthropic-native" as const,
        resultCount: 1,
        durationMs: 100,
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
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "...",
        toolUseId: "tc-1",
        activityMetadata: metadata,
      },
      ctx,
    );
    expect(ctx.turnActions.onToolActivityMetadata).toHaveBeenCalledWith(
      "tc-1",
      metadata,
    );
  });

  it("does NOT route activityMetadata when toolUseId is missing", () => {
    const ctx = makeCtx();
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "...",
        activityMetadata: { webSearch: undefined },
      },
      ctx,
    );
    expect(ctx.turnActions.onToolActivityMetadata).not.toHaveBeenCalled();
  });
});
