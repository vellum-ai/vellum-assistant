import { afterEach, describe, expect, it } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
} from "@/domains/chat/utils/stream-handlers/surface-handlers";

import { textBody } from "@/domains/chat/utils/message-test-helpers";

function seedSnapshot(messages: DisplayMessage[]): void {
  useChatSessionStore.setState({
    snapshot: {
      messages,
      seq: null,
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
    },
  });
}

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});
describe("handleUISurfaceShow", () => {
  it("increments assets refresh key for dynamic_page", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", conversationId: "c-1", surfaceId: "s-1", surfaceType: "dynamic_page", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.showSurface).toHaveBeenCalled();
  });

  it("increments assets refresh key for document_preview", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", conversationId: "c-1", surfaceId: "s-1", surfaceType: "document_preview", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
  });

  it("does not increment assets refresh key for other surface types", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", conversationId: "c-1", surfaceId: "s-1", surfaceType: "form", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });
});

describe("handleUISurfaceUpdate", () => {
  it("dispatches UI_SURFACE_UPDATE", () => {
    const ctx = makeCtx();
    handleUISurfaceUpdate(
      { type: "ui_surface_update", conversationId: "c-1", surfaceId: "s-1", data: { key: "value" } },
      ctx,
    );
    expect(ctx.turnActions.updateSurface).toHaveBeenCalled();
  });
});

describe("handleUISurfaceDismiss", () => {
  it("adds surfaceId to dismissed set", () => {
    const ctx = makeCtx();
    handleUISurfaceDismiss(
      { type: "ui_surface_dismiss", conversationId: "c-1", surfaceId: "s-1" },
      ctx,
    );
    expect(ctx.turnActions.dismissSurface).toHaveBeenCalled();
    expect(ctx.addDismissedSurfaceId).toHaveBeenCalledWith("s-1");
  });
});

describe("handleUISurfaceComplete", () => {
  it("increments refresh key when completed surface is dynamic_page", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      ...textBody(""),
      timestamp: 1,
      surfaces: [
        { surfaceId: "s-1", surfaceType: "dynamic_page", data: {} },
      ],
    };
    seedSnapshot([msg]);
    const ctx = makeCtx();
    handleUISurfaceComplete(
      { type: "ui_surface_complete", conversationId: "c-1", surfaceId: "s-1", summary: "Done" },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.completeSurface).toHaveBeenCalled();
  });

  it("does not increment refresh key for non-dynamic surface types", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      ...textBody(""),
      timestamp: 1,
      surfaces: [
        { surfaceId: "s-1", surfaceType: "form", data: {} },
      ],
    };
    seedSnapshot([msg]);
    const ctx = makeCtx();
    handleUISurfaceComplete(
      { type: "ui_surface_complete", conversationId: "c-1", surfaceId: "s-1", summary: "Done" },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });
});
