import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleUsageUpdate,
  handleConversationListInvalidated,
  handleConversationTitleUpdated,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
  handleDiskPressureStatusChanged,
  handleIdentityChanged,
  handleAvatarUpdated,
} from "@/domains/chat/utils/stream-handlers/metadata-handlers.js";

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
    handleUsageUpdate(
      { type: "usage_update", contextWindowTokens: 5000 },
      ctx,
    );
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
      ctx.contextWindowUsageByConversationRef.current.get("conv-1")
        ?.fillRatio,
    ).toBe(1);
  });
});

describe("handleConversationListInvalidated", () => {
  it("schedules conversation list refetch", () => {
    const ctx = makeCtx();
    handleConversationListInvalidated(
      { type: "conversation_list_invalidated", reason: "created" },
      ctx,
    );
    expect(ctx.scheduleConversationListRefetch).toHaveBeenCalled();
  });
});

describe("handleConversationTitleUpdated", () => {
  it("dispatches PATCH_CONVERSATION with updated title", () => {
    const ctx = makeCtx();
    handleConversationTitleUpdated(
      {
        type: "conversation_title_updated",
        conversationId: "conv-1",
        title: "New Title",
      },
      ctx,
    );
    expect(ctx.dispatchConversationList).toHaveBeenCalledWith({
      type: "PATCH_CONVERSATION",
      key: "conv-1",
      patch: { title: "New Title" },
    });
  });
});

describe("handleCompactionCircuitOpen", () => {
  it("sets compaction circuit open until date", () => {
    const ctx = makeCtx();
    handleCompactionCircuitOpen(
      {
        type: "compaction_circuit_open",
        conversationId: "conv-1",
        reason: "test",
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

describe("handleDiskPressureStatusChanged", () => {
  it("delegates to applyDiskPressureStatusEvent", () => {
    const ctx = makeCtx();
    handleDiskPressureStatusChanged(
      { type: "disk_pressure_status_changed", status: null },
      ctx,
    );
    expect(ctx.applyDiskPressureStatusEvent).toHaveBeenCalledWith(null);
  });
});

describe("handleIdentityChanged", () => {
  it("calls refreshAssistantIdentity with force=true", () => {
    const ctx = makeCtx();
    handleIdentityChanged({ type: "identity_changed" }, ctx);
    expect(ctx.refreshAssistantIdentity).toHaveBeenCalledWith(true);
  });
});

describe("handleAvatarUpdated", () => {
  it("calls invalidateAvatar", () => {
    const ctx = makeCtx();
    handleAvatarUpdated({ type: "avatar_updated" }, ctx);
    expect(ctx.invalidateAvatar).toHaveBeenCalled();
  });
});
