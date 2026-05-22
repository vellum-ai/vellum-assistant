import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleToolProgress,
  handleToolResult,
  handleToolUseStart,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers.js";

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
    expect(ctx.needsNewBubbleRef.current).toBe(false);
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

  it("creates new bubble when needsNewBubbleRef is true", () => {
    const ctx = makeCtx({ needsNewBubbleRef: { current: true } });
    handleToolUseStart(
      { type: "tool_use_start", toolName: "web_search", input: {} },
      ctx,
    );
    expect(ctx.needsNewBubbleRef.current).toBe(false);
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

describe("handleToolProgress", () => {
  it("updates messages via applyToolProgress", () => {
    const ctx = makeCtx();
    handleToolProgress(
      {
        type: "tool_progress",
        toolName: "web_search",
        elapsedSec: 15,
        timeoutSec: 60,
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});
