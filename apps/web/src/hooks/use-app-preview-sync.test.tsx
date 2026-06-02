import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { __resetForTesting, publish } from "@/lib/event-bus";

// `revealAppForBuild` → `loadApp`'s fetch hits `appsByIdOpenPost`. Mock the
// daemon SDK so the call resolves in-process (the synchronous view
// transition under test lands first) and no unhandled rejection escapes.
// Bun's `mock.module` leaks across files — run this file on its own.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: () =>
    Promise.resolve({
      data: { appId: "app-1", dirName: "my-app", name: "My App", html: "<h1>App</h1>" },
    }),
  documentsByIdGet: () => Promise.resolve({ data: null }),
}));

const { useAppPreviewSync } = await import("@/hooks/use-app-preview-sync");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useConversationStore } = await import("@/stores/conversation-store");

function emitPreview(
  appId: string,
  compileStatus: "building" | "ok" | "error",
  opts: { conversationId?: string; reloadGeneration?: number; html?: string } = {},
): void {
  publish("sse.event", {
    id: "evt-1",
    conversationId: opts.conversationId,
    emittedAt: new Date().toISOString(),
    message: {
      type: "app_preview_update",
      appId,
      html: opts.html ?? "<h1>App</h1>",
      compileStatus,
      reloadGeneration: opts.reloadGeneration ?? 0,
    },
  } as unknown as AssistantEventEnvelope);
}

type Params = Parameters<typeof useAppPreviewSync>[0];
const DESKTOP_ACTIVE: Params = {
  assistantId: "asst-1",
  isAssistantActive: true,
  isMobile: false,
};

beforeEach(() => {
  __resetForTesting();
  useViewerStore.getState().reset();
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("conv-1");
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useAppPreviewSync auto-open", () => {
  test("a first building event for a non-open app opens the app-editing split", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("app-editing");
    expect(viewer.activeAppId).toBe("app-1");
    // The edit-chat target is set so the desktop branch renders.
    expect(useConversationStore.getState().editingConversationId).toBe("conv-1");
  });

  test("falls back to the active conversation when the envelope omits one", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    emitPreview("app-1", "building");
    expect(useConversationStore.getState().editingConversationId).toBe("conv-1");
  });

  test("does not disrupt an app that is already open", () => {
    useViewerStore.setState({
      mainView: "app-editing",
      activeAppId: "app-1",
      openedAppState: {
        appId: "app-1",
        dirName: "my-app",
        name: "My App",
        html: "<h1>App</h1>",
      },
    });
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("app-editing");
    expect(viewer.activeAppId).toBe("app-1");
  });

  test("does not re-open an app dismissed during the same build", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    // Build starts → panel opens.
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    // User closes the panel mid-build.
    useViewerStore.getState().closeApp();
    expect(useViewerStore.getState().dismissedBuildAppId).toBe("app-1");
    // Subsequent events for the SAME build do not pop it back open.
    emitPreview("app-1", "ok", { conversationId: "conv-1", reloadGeneration: 1 });
    emitPreview("app-1", "ok", { conversationId: "conv-1", reloadGeneration: 2 });
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
  });

  test("a fresh build sequence re-opens after a dismissal", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    emitPreview("app-1", "ok", { conversationId: "conv-1", reloadGeneration: 1 });
    // User closes mid/after build.
    useViewerStore.getState().closeApp();
    expect(useViewerStore.getState().dismissedBuildAppId).toBe("app-1");
    // A NEW build sequence begins (building after a terminal ok) → the
    // hook clears the dismissal and the panel re-opens.
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().dismissedBuildAppId).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("app-editing");
  });

  test("a terminal ok does not yank the user back after they navigate away mid-build", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    // Build starts → panel opens.
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    // User navigates away to a document — a path that does NOT mark the app
    // as dismissed.
    useViewerStore.setState({ mainView: "document", activeAppId: null });
    // The terminal `ok` for the same build arrives — it must NOT reopen the
    // split-view.
    emitPreview("app-1", "ok", { conversationId: "conv-1", reloadGeneration: 1 });
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(useViewerStore.getState().activeAppId).toBeNull();
  });

  test("a terminal error does not auto-open a not-yet-open app", () => {
    renderHook(() => useAppPreviewSync(DESKTOP_ACTIVE));
    // A terminal status with no prior build-start for this app: must not open.
    emitPreview("app-1", "error", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
  });

  test("does not auto-open when the assistant is not active", () => {
    renderHook(() =>
      useAppPreviewSync({ ...DESKTOP_ACTIVE, isAssistantActive: false }),
    );
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
  });

  test("does not auto-open when there is no active assistant", () => {
    renderHook(() => useAppPreviewSync({ ...DESKTOP_ACTIVE, assistantId: null }));
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("does not force the split on mobile", () => {
    renderHook(() => useAppPreviewSync({ ...DESKTOP_ACTIVE, isMobile: true }));
    emitPreview("app-1", "building", { conversationId: "conv-1" });
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
  });
});
