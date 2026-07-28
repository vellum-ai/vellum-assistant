/**
 * `open_panel` acknowledgment.
 *
 * The daemon holds the emitting `ui_show channel_setup` tool call open until
 * a client confirms the panel rendered, so the handler must ack after opening
 * and nack (with a reason) when it cannot open — a silent drop would surface
 * to the model as a timeout it can't distinguish from a disconnected client.
 * Events without a `surfaceId` come from daemons that expect no ack.
 *
 * `open_url` dispatch.
 *
 * Browser hand-offs (OAuth authorization pages, external links) arrive as
 * `open_url` events. Automatic opens carry no user activation, so a blocked
 * `window.open` must surface a notice with the URL for a click-driven retry
 * rather than failing silently.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { OpenPanelEvent, OpenUrlEvent } from "@vellumai/assistant-api";

const submitSurfaceActionCalls: Array<{
  assistantId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
  conversationId?: string;
}> = [];

mock.module("@/domains/chat/api/surfaces", () => ({
  submitSurfaceAction: async (
    assistantId: string,
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
    conversationId?: string,
  ) => {
    submitSurfaceActionCalls.push({
      assistantId,
      surfaceId,
      actionId,
      data,
      conversationId,
    });
    return { ok: true };
  },
}));

let nativeOpenUrlMock = mock((_url: string) => Promise.resolve());
mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => nativeOpenUrlMock(url),
}));

const { handleOpenPanel, handleOpenUrl, handleOpenConversation } =
  await import("@/domains/chat/utils/stream-handlers/navigation-handlers");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useConversationStore } = await import("@/stores/conversation-store");

function makeCtx(
  overrides: Partial<StreamHandlerContext> = {},
): StreamHandlerContext {
  return {
    assistantId: "ast-1",
    streamContext: { assistantId: "ast-1", conversationId: "conv-1" },
    ...overrides,
  } as unknown as StreamHandlerContext;
}

function makeEvent(overrides: Partial<OpenPanelEvent> = {}): OpenPanelEvent {
  return {
    type: "open_panel",
    panelType: "channel_setup",
    data: { channel: "slack" },
    conversationId: "conv-1",
    surfaceId: "surf-1",
    ...overrides,
  };
}

const originalWindow = globalThis.window;

function setMockWindow({
  origin = "https://app.vellum.ai",
  open,
}: {
  origin?: string;
  open?:
    | ((url?: string, target?: string, features?: string) => Window | null)
    | null;
} = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin },
      open,
    },
  });
}

beforeEach(() => {
  submitSurfaceActionCalls.length = 0;
  nativeOpenUrlMock = mock((_url: string) => Promise.resolve());
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("handleOpenPanel acknowledgment", () => {
  it("opens the channel setup drawer and acks", () => {
    handleOpenPanel(makeEvent(), makeCtx());

    expect(useViewerStore.getState().mainView).toBe("channel-setup");
    expect(useViewerStore.getState().activeChannelSetup?.channel).toBe("slack");
    expect(useViewerStore.getState().activeChannelSetup?.conversationId).toBe(
      "conv-1",
    );
    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-1",
        actionId: "ack",
        data: undefined,
        conversationId: "conv-1",
      },
    ]);
  });

  it("nacks with a reason when the stream has no assistant", () => {
    handleOpenPanel(
      makeEvent({ surfaceId: "surf-2" }),
      makeCtx({ assistantId: null }),
    );

    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-2",
        actionId: "nack",
        data: { reason: "no_active_assistant" },
        conversationId: "conv-1",
      },
    ]);
  });

  it("nacks unknown panel types instead of silently dropping them", () => {
    handleOpenPanel(
      makeEvent({ panelType: "not_a_real_panel", surfaceId: "surf-3" }),
      makeCtx(),
    );

    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-3",
        actionId: "nack",
        data: { reason: "unknown_panel_type" },
        conversationId: "conv-1",
      },
    ]);
  });

  it("sends no ack for events without a surfaceId", () => {
    handleOpenPanel(makeEvent({ surfaceId: undefined }), makeCtx());

    expect(useViewerStore.getState().mainView).toBe("channel-setup");
    expect(submitSurfaceActionCalls).toHaveLength(0);
  });
});

describe("handleOpenUrl", () => {
  const oauthUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback";

  function makeOpenUrlCtx(overrides: Partial<StreamHandlerContext> = {}): {
    ctx: StreamHandlerContext;
    push: ReturnType<typeof mock>;
    setError: ReturnType<typeof mock>;
    setNotice: ReturnType<typeof mock>;
  } {
    const push = mock((_url: string) => {});
    const setError = mock(() => {});
    const setNotice = mock(() => {});
    const ctx = {
      router: { push },
      isNative: false,
      setError,
      setNotice,
      ...overrides,
    } as unknown as StreamHandlerContext;
    return { ctx, push, setError, setNotice };
  }

  function makeOpenUrlEvent(url: string): OpenUrlEvent {
    // No conversationId — matches CLI signal-bridge emits.
    return { type: "open_url", url };
  }

  it("routes same-origin URLs through the client router", () => {
    setMockWindow({ open: null });
    const { ctx, push } = makeOpenUrlCtx();

    handleOpenUrl(
      makeOpenUrlEvent("https://app.vellum.ai/settings?tab=x"),
      ctx,
    );

    expect(push).toHaveBeenCalledWith("/settings?tab=x");
  });

  it("opens OAuth-shaped URLs in the sized popup", () => {
    const popup = { focus: mock(() => {}) } as unknown as Window;
    const open = mock(() => popup);
    setMockWindow({ open });
    const { ctx, setError, setNotice } = makeOpenUrlCtx();

    handleOpenUrl(makeOpenUrlEvent(oauthUrl), ctx);

    expect(open).toHaveBeenCalledWith(
      oauthUrl,
      "_blank",
      "width=500,height=600",
    );
    expect(setError).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("surfaces a clickable notice when the browser blocks the open", () => {
    const open = mock(() => null);
    setMockWindow({ open });
    const { ctx, setError, setNotice } = makeOpenUrlCtx();

    handleOpenUrl(makeOpenUrlEvent(oauthUrl), ctx);

    expect(setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ actionUrl: oauthUrl }),
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("routes through the runtime opener on native", () => {
    setMockWindow({ open: null });
    const { ctx, setNotice } = makeOpenUrlCtx({ isNative: true });

    handleOpenUrl(makeOpenUrlEvent("https://example.com/docs"), ctx);

    expect(nativeOpenUrlMock).toHaveBeenCalledWith("https://example.com/docs");
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) URLs with an error", () => {
    setMockWindow({ open: null });
    const { ctx, setError, setNotice } = makeOpenUrlCtx();

    handleOpenUrl(
      makeOpenUrlEvent("x-apple.systempreferences:com.apple.preference"),
      ctx,
    );

    expect(setError).toHaveBeenCalledTimes(1);
    expect(setNotice).not.toHaveBeenCalled();
  });
});

describe("handleOpenConversation", () => {
  it("switches to and focuses the target conversation by default", () => {
    useConversationStore.getState().setActiveConversationId("conv-origin");
    const push = mock((_url: string) => {});
    const ctx = { router: { push } } as unknown as StreamHandlerContext;

    handleOpenConversation(
      { type: "open_conversation", conversationId: "conv-target" },
      ctx,
    );

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-target",
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toContain("conv-target");
  });

  it("does not switch focus when focus is false", () => {
    useConversationStore.getState().setActiveConversationId("conv-origin");
    const push = mock((_url: string) => {});
    const ctx = { router: { push } } as unknown as StreamHandlerContext;

    handleOpenConversation(
      {
        type: "open_conversation",
        conversationId: "conv-target",
        focus: false,
      },
      ctx,
    );

    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-origin",
    );
    expect(push).not.toHaveBeenCalled();
  });
});
