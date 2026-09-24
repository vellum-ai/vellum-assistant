/**
 * Conversationless `open_url` directives open from any attended route, so the
 * envelope handler is exercised directly (the hook only wires it to the
 * bus). Conversation-bound events must be left to the chat stream
 * consumer — handling them here too would double-open for the active
 * conversation and let background turns open windows over unrelated ones.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { stubBrowserAttention } from "@/runtime/window-attention.test-helper";

let isNativePlatformMock = false;
mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock,
  },
  // `@/runtime/native-auth` (imported by the hook module) registers a
  // Capacitor plugin at module load.
  registerPlugin: () => ({}),
}));

let nativeOpenUrlMock = mock((_url: string) => Promise.resolve());
mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => nativeOpenUrlMock(url),
}));

const toastWarningMock = mock(
  (_message: string, _options?: Record<string, unknown>) => "toast-1",
);
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: Object.assign(
    mock(() => "toast-0"),
    {
      warning: toastWarningMock,
    },
  ),
}));

const { handleOpenUrlDirectiveEnvelope } =
  await import("@/hooks/use-open-url-directives");

const originalWindow = globalThis.window;
let attention: ReturnType<typeof stubBrowserAttention>;

function setMockWindow({
  origin = "https://app.vellum.ai",
  open,
  vellum,
}: {
  origin?: string;
  open?:
    | ((url?: string, target?: string, features?: string) => Window | null)
    | null;
  vellum?: unknown;
} = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin },
      open,
      vellum,
    },
  });
}

function makeEnvelope(
  message: Record<string, unknown>,
  envelopeConversationId?: string,
): AssistantEventEnvelope {
  return {
    id: "evt-1",
    emittedAt: "2026-01-01T00:00:00.000Z",
    conversationId: envelopeConversationId,
    message,
  } as AssistantEventEnvelope;
}

beforeEach(() => {
  attention = stubBrowserAttention();
  attention.set({ visible: true, focused: true });
  isNativePlatformMock = false;
  nativeOpenUrlMock = mock((_url: string) => Promise.resolve());
  toastWarningMock.mockClear();
});

afterEach(() => {
  attention.restore();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("handleOpenUrlDirectiveEnvelope", () => {
  const oauthUrl =
    "https://mcp.example.com/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback";
  const deps = () => ({ isNative: false, push: mock((_p: string) => {}) });

  it("opens a conversationless open_url directive", () => {
    const popup = { focus: mock(() => {}) } as unknown as Window;
    const open = mock(() => popup);
    setMockWindow({ open });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "open_url", url: oauthUrl }),
      deps(),
    );

    expect(open).toHaveBeenCalledWith(
      oauthUrl,
      "_blank",
      "width=500,height=600",
    );
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("ignores conversation-bound open_url (owned by the chat stream consumer)", () => {
    const open = mock(() => null);
    setMockWindow({ open });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope(
        { type: "open_url", url: oauthUrl, conversationId: "conv-1" },
        "conv-1",
      ),
      deps(),
    );
    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "open_url", url: oauthUrl }, "conv-1"),
      deps(),
    );

    expect(open).not.toHaveBeenCalled();
  });

  it("opens the shared directive only in the visible, focused browser tab", () => {
    const popup = { focus: mock(() => {}) } as unknown as Window;
    const open = mock(() => popup);
    setMockWindow({ open });
    const envelope = makeEnvelope({ type: "open_url", url: oauthUrl });

    for (const state of [
      { visible: false, focused: false },
      { visible: true, focused: false },
      { visible: true, focused: true },
    ]) {
      attention.set(state);
      handleOpenUrlDirectiveEnvelope(envelope, deps());
    }

    expect(open).toHaveBeenCalledTimes(1);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("does not navigate or show a blocked-popup toast in an unattended tab", () => {
    const open = mock(() => null);
    const { push } = deps();
    setMockWindow({ open });

    for (const state of [
      { visible: false, focused: false },
      { visible: true, focused: false },
    ]) {
      attention.set(state);
      for (const url of [oauthUrl, "https://app.vellum.ai/settings"]) {
        handleOpenUrlDirectiveEnvelope(
          makeEnvelope({ type: "open_url", url }),
          { isNative: false, push },
        );
      }
    }

    expect(open).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("ignores non-open_url events", () => {
    const open = mock(() => null);
    setMockWindow({ open });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "sync_changed", tags: ["x"] }),
      deps(),
    );

    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to a click-to-open toast when the browser blocks the open", () => {
    const open = mock(() => null);
    setMockWindow({ open });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "open_url", url: oauthUrl }),
      deps(),
    );

    expect(toastWarningMock).toHaveBeenCalledTimes(1);
    const options = toastWarningMock.mock.calls[0]?.[1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(options?.action?.label).toBe("Open page");
    expect(toastWarningMock.mock.calls[0]?.[0]).toBe(
      "Your browser blocked a page the assistant tried to open.",
    );

    // The action click re-opens; with a user gesture the popup succeeds.
    const popup = { focus: mock(() => {}) } as unknown as Window;
    const openOnClick = mock(() => popup);
    setMockWindow({ open: openOnClick });
    options.action?.onClick();
    expect(openOnClick).toHaveBeenCalled();
  });

  it("routes through the runtime opener on native", () => {
    setMockWindow({ open: null });
    attention.set({ visible: false, focused: false });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "open_url", url: "https://example.com/docs" }),
      { isNative: true, push: mock((_p: string) => {}) },
    );

    expect(nativeOpenUrlMock).toHaveBeenCalledWith("https://example.com/docs");
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("preserves Electron handoff without browser focus", () => {
    const popup = { focus: mock(() => {}) } as unknown as Window;
    const open = mock(() => popup);
    setMockWindow({ open, vellum: { platform: "electron" } });
    attention.set({ visible: false, focused: false });

    handleOpenUrlDirectiveEnvelope(
      makeEnvelope({ type: "open_url", url: oauthUrl }),
      deps(),
    );

    expect(open).toHaveBeenCalledTimes(1);
  });
});
