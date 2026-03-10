import { describe, expect, test } from "bun:test";

import type {
  CardSurfaceData,
  DynamicPageSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
  UiSurfaceUpdate,
} from "../daemon/message-protocol.js";
import {
  createSurfaceMutex,
  surfaceProxyResolver,
  type SurfaceSessionContext,
} from "../daemon/session-surfaces.js";

function makeContext(
  sent: ServerMessage[] = [],
  channelCapabilities?: SurfaceSessionContext["channelCapabilities"],
): SurfaceSessionContext {
  return {
    conversationId: "session-1",
    channelCapabilities,
    traceEmitter: { emit: () => {} },
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map<string, string[]>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

describe("task_progress surface compatibility", () => {
  test("blocks ui_show when channel lacks dynamic UI support", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "phone",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Blocked", body: "blocked" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_show is unavailable on channel "phone"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks ui_update when channel lacks dynamic UI support", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "telegram",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: { status: "completed" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "telegram"',
    );
    expect(sent).toHaveLength(0);
  });

  test("ui_show maps legacy top-level task_progress fields into card data", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Ordering from DoorDash",
      data: {},
      template: "task_progress",
      templateData: {
        status: "in_progress",
        steps: [
          { label: "Search restaurants", status: "in_progress" },
          { label: "Browse menu", status: "pending" },
        ],
      },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "card") return;

    const card = showMessage.data as CardSurfaceData;
    expect(card.template).toBe("task_progress");
    expect(card.title).toBe("Ordering from DoorDash");
    expect(card.body).toBe("");
    expect((card.templateData as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });

  test("ui_show normalizes top-level dynamic_page fields into data", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "dynamic_page",
      title: "My Slides",
      html: "<h1>Hello</h1>",
      preview: { title: "Slides", subtitle: "3 slides about Apple" },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "dynamic_page") return;

    const page = showMessage.data as DynamicPageSurfaceData;
    expect(page.html).toBe("<h1>Hello</h1>");
    expect(page.preview).toEqual({
      title: "Slides",
      subtitle: "3 slides about Apple",
    });
  });

  test("ui_show supports file_upload surfaces directly", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "file_upload",
      title: "Upload a receipt",
      data: {
        prompt: "Share the receipt PDF",
        acceptedTypes: ["application/pdf"],
        maxFiles: 1,
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "file_upload") return;

    expect(showMessage.title).toBe("Upload a receipt");
    expect(showMessage.data).toEqual({
      prompt: "Share the receipt PDF",
      acceptedTypes: ["application/pdf"],
      maxFiles: 1,
    });
    expect(ctx.pendingSurfaceActions.get(showMessage.surfaceId)).toEqual({
      surfaceType: "file_upload",
    });
  });

  test("ui_show dynamic_page uses data.html when properly nested", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "dynamic_page",
      title: "My Slides",
      data: { html: "<h1>Nested</h1>" },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "dynamic_page") return;

    const page = showMessage.data as DynamicPageSurfaceData;
    expect(page.html).toBe("<h1>Nested</h1>");
  });

  test("ui_update normalizes top-level task_progress fields into templateData", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);
    const existingCard: CardSurfaceData = {
      title: "Ordering from DoorDash",
      body: "",
      template: "task_progress",
      templateData: {
        title: "Ordering from DoorDash",
        status: "in_progress",
        steps: [
          { label: "Search restaurants", status: "completed" },
          { label: "Browse menu", status: "in_progress" },
          { label: "Add to cart", status: "pending" },
        ],
      },
    };

    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: existingCard,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: {
        status: "completed",
      },
    });

    expect(result.isError).toBe(false);

    const updateMessage = sent.find(
      (msg): msg is UiSurfaceUpdate => msg.type === "ui_surface_update",
    );
    expect(updateMessage).toBeDefined();
    if (!updateMessage) return;

    const updatedCard = updateMessage.data as CardSurfaceData &
      Record<string, unknown>;
    expect(updatedCard.template).toBe("task_progress");
    expect("status" in updatedCard).toBe(false);
    const templateData = updatedCard.templateData as Record<string, unknown>;
    expect(templateData.status).toBe("completed");
    expect(Array.isArray(templateData.steps)).toBe(true);
  });

  test("ui_show rejects new interactive surface when a non-dynamic_page pending surface exists", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Pre-populate a pending table surface (simulates a previously shown interactive surface)
    ctx.pendingSurfaceActions.set("stale-surface-1", { surfaceType: "table" });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "New Table",
      data: { columns: [], rows: [] },
      actions: [{ id: "archive", label: "Archive" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Another interactive surface is already awaiting user input",
    );
    // The stale entry should still be present (guard only rejects, doesn't clean up)
    expect(ctx.pendingSurfaceActions.has("stale-surface-1")).toBe(true);
  });

  test("ui_show allows new interactive surface when only dynamic_page surfaces are pending", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // dynamic_page pending entries should not block new interactive surfaces
    ctx.pendingSurfaceActions.set("page-1", { surfaceType: "dynamic_page" });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Email Table",
      data: { columns: [], rows: [] },
      actions: [{ id: "archive", label: "Archive" }],
    });

    expect(result.isError).toBe(false);
    expect(sent.some((m) => m.type === "ui_surface_show")).toBe(true);
  });
});
