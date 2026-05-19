import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleToolUseStart,
  handleToolResult,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers.js";

describe("handleToolUseStart", () => {
  it("cancels reconciliation and creates tool call with generated id", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      { type: "tool_use_start", toolName: "web_search", input: { query: "test" } },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.dispatchTurn).toHaveBeenCalledWith({
      type: "TOOL_USE_START",
    });
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
    expect(ctx.dispatchTurn).toHaveBeenCalledWith({
      type: "TOOL_RESULT",
    });
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});
