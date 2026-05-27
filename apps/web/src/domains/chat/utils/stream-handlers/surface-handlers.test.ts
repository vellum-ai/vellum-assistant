import { describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
} from "@/domains/chat/utils/stream-handlers/surface-handlers";

describe("handleUISurfaceShow", () => {
  it("increments assets refresh key for dynamic_page", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", surfaceId: "s-1", surfaceType: "dynamic_page", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.showSurface).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("increments assets refresh key for document_preview", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", surfaceId: "s-1", surfaceType: "document_preview", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
  });

  it("does not increment assets refresh key for other surface types", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      { type: "ui_surface_show", surfaceId: "s-1", surfaceType: "form", data: {} },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });
});

describe("handleUISurfaceUpdate", () => {
  it("dispatches UI_SURFACE_UPDATE and updates messages", () => {
    const ctx = makeCtx();
    handleUISurfaceUpdate(
      { type: "ui_surface_update", surfaceId: "s-1", data: { key: "value" } },
      ctx,
    );
    expect(ctx.turnActions.updateSurface).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

describe("handleUISurfaceDismiss", () => {
  it("adds surfaceId to dismissed set and updates messages", () => {
    const ctx = makeCtx();
    handleUISurfaceDismiss(
      { type: "ui_surface_dismiss", surfaceId: "s-1" },
      ctx,
    );
    expect(ctx.turnActions.dismissSurface).toHaveBeenCalled();
    expect(ctx.dismissedSurfaceIdsRef.current.has("s-1")).toBe(true);
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

describe("handleUISurfaceComplete", () => {
  it("increments refresh key when completed surface is dynamic_page", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      surfaces: [
        { surfaceId: "s-1", surfaceType: "dynamic_page", data: {} },
      ],
    };
    const ctx = makeCtx({ messagesRef: { current: [msg] } });
    handleUISurfaceComplete(
      { type: "ui_surface_complete", surfaceId: "s-1", summary: "Done" },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.completeSurface).toHaveBeenCalled();
  });

  it("does not increment refresh key for non-dynamic surface types", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      surfaces: [
        { surfaceId: "s-1", surfaceType: "form", data: {} },
      ],
    };
    const ctx = makeCtx({ messagesRef: { current: [msg] } });
    handleUISurfaceComplete(
      { type: "ui_surface_complete", surfaceId: "s-1", summary: "Done" },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });
});
