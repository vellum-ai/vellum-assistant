import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";

import {
  handleUsageUpdate,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
} from "@/domains/chat/utils/stream-handlers/metadata-handlers";

const baseUsage = {
  type: "usage_update",
  conversationId: "conv-1",
  inputTokens: 100,
  outputTokens: 50,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  estimatedCost: 0.0021,
  model: "claude-sonnet-4",
} as const;

describe("handleUsageUpdate", () => {
  it("computes fill ratio and updates context window usage", () => {
    const ctx = makeCtx();
    handleUsageUpdate(
      {
        ...baseUsage,
        contextWindowTokens: 5000,
        contextWindowMaxTokens: 10000,
      },
      ctx,
    );
    expect(ctx.setContextWindowUsage).toHaveBeenCalled();
    expect(ctx.setContextWindowUsageForConversation).toHaveBeenCalledWith(
      "conv-1",
      { tokens: 5000, maxTokens: 10000, fillRatio: 0.5 },
    );
  });

  it("returns early for non-finite token counts", () => {
    const ctx = makeCtx();
    handleUsageUpdate({ ...baseUsage, contextWindowTokens: undefined }, ctx);
    expect(ctx.setContextWindowUsage).not.toHaveBeenCalled();
  });

  it("sets fillRatio to null when maxTokens is missing", () => {
    const ctx = makeCtx();
    handleUsageUpdate({ ...baseUsage, contextWindowTokens: 5000 }, ctx);
    expect(ctx.setContextWindowUsageForConversation).toHaveBeenCalledWith(
      "conv-1",
      { tokens: 5000, maxTokens: null, fillRatio: null },
    );
  });

  it("clamps fillRatio to [0, 1]", () => {
    const ctx = makeCtx();
    handleUsageUpdate(
      {
        ...baseUsage,
        contextWindowTokens: 20000,
        contextWindowMaxTokens: 10000,
      },
      ctx,
    );
    expect(ctx.setContextWindowUsageForConversation).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ fillRatio: 1 }),
    );
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
