import { describe, expect, mock, test } from "bun:test";

import type { ServerMessage, SurfaceType } from "../daemon/message-protocol.js";

mock.module("../memory/app-store.js", () => ({
  getApp: (id: string) => {
    if (id !== "home-base-app") return null;
    return {
      id,
      name: "Home Base",
      htmlDefinition:
        '<main id="home-base-root" data-vellum-home-base="v1"></main>',
    };
  },
  updateApp: () => {
    throw new Error("updateApp should not be called in this test");
  },
}));

mock.module("../home-base/prebuilt/seed.js", () => ({
  findSeededHomeBaseApp: () => ({ id: "home-base-app" }),
  getPrebuiltHomeBasePreview: () => ({
    title: "Home Base",
    subtitle: "Dashboard",
    description: "Preview",
    icon: "🏠",
    metrics: [{ label: "Starter tasks", value: "3" }],
  }),
}));

import {
  createSurfaceMutex,
  handleSurfaceAction,
  surfaceProxyResolver,
  type SurfaceSessionContext,
} from "../daemon/session-surfaces.js";

function makeContext(): SurfaceSessionContext {
  return {
    conversationId: "session-1",
    traceEmitter: {
      emit: () => {},
    },
    sendToClient: () => {},
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

describe("starter task surface actions", () => {
  test("forwards prompt payload as normal message content", () => {
    const forwarded: string[] = [];
    const ctx = makeContext();
    ctx.processMessage = async (content) => {
      forwarded.push(content);
      return "ok";
    };
    ctx.pendingSurfaceActions.set("surf-1", { surfaceType: "dynamic_page" });

    handleSurfaceAction(ctx, "surf-1", "relay_prompt", {
      prompt: "Help me customize Home Base with a calmer palette.",
      task: "change_look_and_feel",
    });

    expect(forwarded).toEqual([
      "Help me customize Home Base with a calmer palette.",
    ]);
    expect(ctx.pendingSurfaceActions.has("surf-1")).toBe(true);
  });

  test("falls back to human-readable summary with action data when prompt is absent", () => {
    const forwarded: string[] = [];
    const ctx = makeContext();
    ctx.processMessage = async (content) => {
      forwarded.push(content);
      return "ok";
    };
    ctx.pendingSurfaceActions.set("surf-2", { surfaceType: "dynamic_page" });

    handleSurfaceAction(ctx, "surf-2", "relay_prompt", {
      topic: "weather in sf",
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain("[User action on dynamic_page surface:");
    expect(forwarded[0]).toContain("Action data:");
    expect(forwarded[0]).toContain('"topic":"weather in sf"');
    expect(ctx.pendingSurfaceActions.has("surf-2")).toBe(true);
  });

  test("does not treat prompt-like fields as relay content for non-relay actions", () => {
    const forwarded: string[] = [];
    const ctx = makeContext();
    ctx.processMessage = async (content) => {
      forwarded.push(content);
      return "ok";
    };
    ctx.pendingSurfaceActions.set("surf-3", { surfaceType: "dynamic_page" });

    handleSurfaceAction(ctx, "surf-3", "save_filters", {
      prompt: "keep this literal field",
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain("[User action on dynamic_page surface:");
    expect(forwarded[0]).toContain('"prompt":"keep this literal field"');
  });

  test("consumes non-dynamic pending actions after forwarding", () => {
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set("confirm-1", { surfaceType: "confirmation" });

    handleSurfaceAction(ctx, "confirm-1", "confirm", {});

    expect(ctx.pendingSurfaceActions.has("confirm-1")).toBe(false);
  });

  test("app_open registers dynamic_page surface as action-capable", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext();
    ctx.sendToClient = (msg) => sent.push(msg);

    const result = await surfaceProxyResolver(ctx, "app_open", {
      app_id: "home-base-app",
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      surfaceId: string;
      appId: string;
    };
    expect(parsed.appId).toBe("home-base-app");
    expect(ctx.pendingSurfaceActions.get(parsed.surfaceId)?.surfaceType).toBe(
      "dynamic_page",
    );
    expect(sent.some((msg) => msg.type === "ui_surface_show")).toBe(true);
  });
});
