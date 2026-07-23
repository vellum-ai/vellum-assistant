import { describe, expect, test } from "bun:test";

import { DynamicPagePreviewSchema } from "../api/surfaces.js";
import {
  buildAppOpenPreview,
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type { ServerMessage, SurfaceType } from "../daemon/message-protocol.js";

interface ContextOptions {
  hasNoClient?: boolean;
  channelCapabilities?: { channel: string; supportsDynamicUi: boolean };
}

function makeContext(
  sent: ServerMessage[] = [],
  options: ContextOptions = {},
): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    hasNoClient: options.hasNoClient,
    channelCapabilities: options.channelCapabilities,
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
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

describe("app_open render-capability gate", () => {
  test("returns an error without broadcasting on a clientless turn", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, { hasNoClient: true });

    const result = await surfaceProxyResolver(ctx, "app_open", {
      app_id: "app-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("connected client");
    expect(sent).toHaveLength(0);
  });

  test("returns an error on a channel without dynamic UI (e.g. Slack)", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channelCapabilities: { channel: "slack", supportsDynamicUi: false },
    });

    const result = await surfaceProxyResolver(ctx, "app_open", {
      app_id: "app-1",
    });

    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("buildAppOpenPreview — app-name default vs supplied preview", () => {
  const dflt = { title: "My App", subtitle: "An app that does things" };
  // Inputs are passed through the same schema the app_open path uses, so these
  // exercise the real parse → merge flow (the parse fills `title: ""` for an
  // omitted title, which the merge must not let clobber the app name).
  const parse = (raw: Record<string, unknown>) =>
    DynamicPagePreviewSchema.parse(raw);

  test("no preview keeps the app name and description", () => {
    expect(buildAppOpenPreview(dflt, undefined, null)).toEqual({
      title: "My App",
      subtitle: "An app that does things",
    });
  });

  test("a supplied non-empty title wins over the default", () => {
    const preview = parse({ title: "Custom Title", subtitle: "Custom sub" });
    expect(buildAppOpenPreview(dflt, preview, null)).toMatchObject({
      title: "Custom Title",
      subtitle: "Custom sub",
    });
  });

  test("a preview that omits the title falls back to the app name (not blank)", () => {
    // Parsing `{ subtitle }` yields `title: ""` via `z.string().catch("")`.
    const preview = parse({ subtitle: "Only a subtitle" });
    expect(preview.title).toBe(""); // precondition: the parse fills it blank
    const merged = buildAppOpenPreview(dflt, preview, null);
    expect(merged.title).toBe("My App");
    expect(merged.subtitle).toBe("Only a subtitle");
  });

  test("an explicit empty-string title falls back to the app name", () => {
    const preview = parse({ title: "" });
    expect(buildAppOpenPreview(dflt, preview, null).title).toBe("My App");
  });

  test("a stored preview image always wins", () => {
    const preview = parse({ title: "T", previewImage: "caller-supplied" });
    expect(
      buildAppOpenPreview(dflt, preview, "generated-image").previewImage,
    ).toBe("generated-image");
  });
});
