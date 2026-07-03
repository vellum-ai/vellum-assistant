import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleToolResult,
  handleToolUsePreviewStart,
  handleToolUseStart,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";

// Post client-sync cutover: these handlers no longer mutate transcript
// content. The rolling-snapshot reducer owns tool calls, results, output
// chunks and preview cards. The handlers only stamp the current-assistant
// anchor ref and drive the turn store.

describe("handleToolUsePreviewStart", () => {
  it("stamps the current-assistant anchor from event.messageId", () => {
    const ctx = makeCtx();
    handleToolUsePreviewStart(
      {
        type: "tool_use_preview_start",
        toolUseId: "tc-1",
        toolName: "bash",
        messageId: "anchor-1",
      },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("anchor-1");
  });

  it("leaves the anchor ref untouched when messageId is absent", () => {
    const ctx = makeCtx();
    ctx.currentAssistantMessageIdRef.current = "prev-anchor";
    handleToolUsePreviewStart(
      {
        type: "tool_use_preview_start",
        toolUseId: "tc-1",
        toolName: "bash",
      },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("prev-anchor");
  });
});

describe("handleToolUseStart", () => {
  it("cancels reconciliation and notifies the turn store", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "test" },
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.onToolUseStart).toHaveBeenCalled();
  });

  it("stamps the current-assistant anchor from event.messageId", () => {
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
    expect(ctx.currentAssistantMessageIdRef.current).toBe("server-msg-1");
  });

  it("leaves the anchor ref untouched when messageId is absent", () => {
    const ctx = makeCtx();
    ctx.currentAssistantMessageIdRef.current = "prev-anchor";
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("prev-anchor");
  });
});

describe("handleToolResult", () => {
  it("notifies the turn store of the tool result", () => {
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
  });

  it("routes activityMetadata to onToolActivityMetadata when toolUseId present", () => {
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

  it("does NOT route activityMetadata when metadata is absent", () => {
    const ctx = makeCtx();
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "...",
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.turnActions.onToolActivityMetadata).not.toHaveBeenCalled();
  });
});
