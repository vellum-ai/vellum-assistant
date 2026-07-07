import { describe, expect, test } from "bun:test";

import {
  buildCompletionSummary,
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ChoiceSurfaceData,
  CopyBlockSurfaceData,
  OAuthConnectSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
} from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";

function makeContext(sent: ServerMessage[] = []): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map<
      string,
      {
        surfaceType: SurfaceType;
        data: SurfaceData;
        title?: string;
        actions?: Array<{
          id: string;
          label: string;
          style?: string;
          data?: Record<string, unknown>;
        }>;
      }
    >(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

function getSurfaceTypeEnum(): string[] {
  return (
    uiShowTool.input_schema as {
      properties: { surface_type: { enum: string[] } };
    }
  ).properties.surface_type.enum;
}

describe("choice and copy_block surface definitions", () => {
  test("ui_show advertises the new surface types", () => {
    expect(getSurfaceTypeEnum()).toContain("choice");
    expect(getSurfaceTypeEnum()).toContain("copy_block");
    expect(getSurfaceTypeEnum()).toContain("oauth_connect");
    expect(uiShowTool.description).toContain("recommended");
    expect(uiShowTool.description).toContain("visible copy button");
    expect(uiShowTool.description).toContain("managed OAuth");
  });

  test("choice and oauth_connect are interactive but copy_block is display-only", () => {
    expect(INTERACTIVE_SURFACE_TYPES).toContain("choice");
    expect(INTERACTIVE_SURFACE_TYPES).toContain("oauth_connect");
    expect(INTERACTIVE_SURFACE_TYPES).not.toContain("copy_block");
  });
});

describe("choice and copy_block surface proxying", () => {
  test("ui_show normalizes choice options and creates recommended action payloads", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      title: "Pick a next move",
      data: {
        description: "Choose where to start.",
        options: [
          {
            id: "clean-inbox",
            title: "Clean up my inbox",
            description: "Triage unread mail and archive noise.",
            recommended: true,
            data: { outcome: "inbox_cleanup" },
          },
          { id: "plan-week", title: "Plan my week" },
          { id: "", title: "Ignored" },
        ],
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "choice") return;

    const data = showMessage.data as ChoiceSurfaceData;
    expect(data.options.map((option) => option.id)).toEqual([
      "clean-inbox",
      "plan-week",
    ]);
    expect(data.options[0].recommended).toBe(true);
    expect(showMessage.actions?.[0]).toEqual({
      id: "clean-inbox",
      label: "Clean up my inbox",
      style: "primary",
      data: {
        choiceId: "clean-inbox",
        choiceTitle: "Clean up my inbox",
        selectedIds: ["clean-inbox"],
        selectedTitles: ["Clean up my inbox"],
        choiceDescription: "Triage unread mail and archive noise.",
        recommended: true,
        outcome: "inbox_cleanup",
      },
    });
    expect(ctx.pendingSurfaceActions.get(showMessage.surfaceId)).toEqual({
      surfaceType: "choice",
    });
  });

  test("ui_show rejects choice surfaces without valid options", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "choice",
      data: { options: [{ id: "", title: "Missing id" }] },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "choice surfaces require at least one option",
    );
    expect(sent).toHaveLength(0);
  });

  test("ui_show passes copy_block data through without awaiting action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "copy_block",
      data: {
        text: "Paste this prompt into another assistant.",
        label: "Port prompt",
        language: "text",
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "copy_block") return;

    expect(showMessage.data as CopyBlockSurfaceData).toEqual({
      text: "Paste this prompt into another assistant.",
      label: "Port prompt",
      language: "text",
    });
    expect(ctx.pendingSurfaceActions.has(showMessage.surfaceId)).toBe(false);
  });

  test("ui_show passes oauth_connect data through and awaits action", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "oauth_connect",
      title: "Connect Google",
      data: {
        providerKey: "google",
        displayName: "Google",
        description: "Connect Gmail for this task.",
        connectLabel: "Connect Google Account",
        requestedScopes: ["gmail.readonly"],
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "oauth_connect") return;

    expect(showMessage.data as OAuthConnectSurfaceData).toEqual({
      providerKey: "google",
      displayName: "Google",
      description: "Connect Gmail for this task.",
    });
    expect(ctx.pendingSurfaceActions.get(showMessage.surfaceId)).toEqual({
      surfaceType: "oauth_connect",
    });
  });

  test("ui_show rejects oauth_connect without providerKey", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "oauth_connect",
      data: { displayName: "Google" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("data.providerKey");
    expect(sent).toHaveLength(0);
  });

  test("choice completion summary names multi-select choices", () => {
    expect(
      buildCompletionSummary("choice", "submit", {
        selectedIds: ["a", "b"],
        selectedTitles: ["Clean up my inbox", "Plan my week"],
      }),
    ).toBe('User chose 2 options: "Clean up my inbox", "Plan my week"');
  });

  test("oauth_connect completion summary names the connected account", () => {
    expect(
      buildCompletionSummary("oauth_connect", "connect", {
        providerKey: "google",
        providerLabel: "Google",
        accountLabel: "user@example.com",
        status: "connected",
      }),
    ).toBe("Connected Google: user@example.com");
  });
});
