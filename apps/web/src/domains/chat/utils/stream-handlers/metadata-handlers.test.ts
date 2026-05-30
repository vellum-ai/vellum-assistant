import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";

import {
  handleUsageUpdate,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
} from "@/domains/chat/utils/stream-handlers/metadata-handlers";

describe("handleUsageUpdate", () => {
  it("computes fill ratio and updates context window usage", () => {
    const ctx = makeCtx();
    handleUsageUpdate(
      {
        type: "usage_update",
        contextWindowTokens: 5000,
        contextWindowMaxTokens: 10000,
      },
      ctx,
    );
    expect(ctx.setContextWindowUsage).toHaveBeenCalled();
    expect(
      ctx.contextWindowUsageByConversationRef.current.get("conv-1"),
    ).toEqual({
      tokens: 5000,
      maxTokens: 10000,
      fillRatio: 0.5,
    });
  });

  it("returns early for non-finite token counts", () => {
    const ctx = makeCtx();
    handleUsageUpdate(
      { type: "usage_update", contextWindowTokens: undefined },
      ctx,
    );
    expect(ctx.setContextWindowUsage).not.toHaveBeenCalled();
  });

  it("sets fillRatio to null when maxTokens is missing", () => {
    const ctx = makeCtx();
    handleUsageUpdate({ type: "usage_update", contextWindowTokens: 5000 }, ctx);
    expect(
      ctx.contextWindowUsageByConversationRef.current.get("conv-1"),
    ).toEqual({
      tokens: 5000,
      maxTokens: null,
      fillRatio: null,
    });
  });

  it("clamps fillRatio to [0, 1]", () => {
    const ctx = makeCtx();
    handleUsageUpdate(
      {
        type: "usage_update",
        contextWindowTokens: 20000,
        contextWindowMaxTokens: 10000,
      },
      ctx,
    );
    expect(
      ctx.contextWindowUsageByConversationRef.current.get("conv-1")?.fillRatio,
    ).toBe(1);
  });
});

describe("handleCompactionCircuitOpen", () => {
  it("sets compaction circuit open until date", () => {
    const ctx = makeCtx();
    handleCompactionCircuitOpen(
      {
        type: "compaction_circuit_open",
        conversationId: "conv-1",
        reason: "3_consecutive_failures",
        openUntil: Date.now() + 60000,
      },
      ctx,
    );
    expect(ctx.setCompactionCircuitOpenUntil).toHaveBeenCalled();
  });
});

describe("handleCompactionCircuitClosed", () => {
  it("clears compaction circuit with null", () => {
    const ctx = makeCtx();
    handleCompactionCircuitClosed(
      { type: "compaction_circuit_closed", conversationId: "conv-1" },
      ctx,
    );
    expect(ctx.setCompactionCircuitOpenUntil).toHaveBeenCalledWith(null);
  });
});


