/**
 * Unit tests for the imperative `navigateToConversation` and
 * `navigateToNewConversation` navigators.
 *
 * Focus: they reset stale viewer state (main view, subagent / workflow panels,
 * transcript side-panel payloads), update the active conversation, and fire
 * exactly one haptic tap, unless the caller opts out via `{ silent: true }`.
 * The fork action taps at action start and routes navigation through this
 * helper, so it relies on `silent` to avoid a double buzz.
 *
 * When an app is already on screen on a wide viewport, conversation
 * navigation keeps that app in the side-by-side layout instead of
 * dismissing it to chat.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

const hapticLight = mock(() => {});
const playSound = mock((_name: string) => Promise.resolve());
const composerFocus = mock(() => {});

mock.module("@/utils/haptics", () => ({
  haptic: {
    light: hapticLight,
    medium: () => {},
    success: () => {},
    error: () => {},
  },
}));
mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: playSound }),
}));
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: composerFocus,
}));

const {
  navigateToConversation,
  navigateToNewConversation,
  keepOpenAppBesideConversation,
  revealConversationView,
} = await import("@/utils/conversation-navigation");

const SAMPLE_APP = { appId: "app-1", name: "My App", html: "<h1>hi</h1>" };

function openAppViewer(view: "app" | "app-editing" = "app"): void {
  useViewerStore.setState({
    mainView: view,
    activeAppId: SAMPLE_APP.appId,
    openedAppState: SAMPLE_APP,
  });
}

let restoreViewport: (() => void) | undefined;

beforeEach(() => {
  hapticLight.mockClear();
  playSound.mockClear();
  composerFocus.mockClear();
  useViewerStore.getState().reset();
  useConversationStore.getState().reset();
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  restoreViewport = stubViewportAxes({
    narrow: false,
    coarsePointer: false,
  });
});

afterEach(() => {
  restoreViewport?.();
  useViewerStore.getState().reset();
  useConversationStore.getState().reset();
});

describe("navigateToConversation", () => {
  test("resets viewer state, sets the active conversation, taps once, navigates", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-1");

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useConversationStore.getState().activeConversationId).toBe("conv-1");
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-1"));
  });

  test("silent suppresses the haptic but still resets state and navigates", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-2", {
      silent: true,
    });

    expect(hapticLight).not.toHaveBeenCalled();
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useConversationStore.getState().activeConversationId).toBe("conv-2");
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-2"));
  });

  test("messageId anchors navigation to that message and still taps", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-3", {
      messageId: "msg-9",
    });

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      routes.conversationAtMessage("conv-3", "msg-9"),
    );
  });

  test("same-conversation navigation keeps subagent/workflow state (LUM-2875)", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sub-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-1");

    // Still returns to the chat view and navigates, but must NOT wipe the
    // process stores — running subagents only repopulate from live SSE.
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useSubagentStore.getState().byId["sub-1"]).toBeDefined();
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-1"));
  });

  test("genuine switch resets subagent/workflow state and panel payloads", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sub-1",
      label: "auditor",
      objective: "audit",
      timestamp: Date.now(),
    });
    useViewerStore.setState({
      activeMessageFiles: {
        messageId: "msg-1",
        attachments: [],
      },
    });
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-2");

    expect(useSubagentStore.getState().byId["sub-1"]).toBeUndefined();
    expect(useViewerStore.getState().activeMessageFiles).toBeNull();
  });

  test("keeps an open app in the side-by-side layout on a wide viewport", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-9");

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-9",
    );
    expect(useConversationStore.getState().activeConversationId).toBe("conv-9");
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-9"));
  });

  test("dismisses an open app on a narrow viewport (no split layout)", () => {
    restoreViewport?.();
    restoreViewport = stubViewportAxes({
      narrow: true,
      coarsePointer: true,
    });
    openAppViewer();
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-9");

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
  });
});

describe("navigateToNewConversation", () => {
  test("resets panel payloads and process stores, taps, focuses the composer", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(useViewerStore.getState().mainView).toBe("chat");
    const newId = useConversationStore.getState().activeConversationId;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("conv-1");
    expect(
      useConversationStore.getState().draftConversationIds.has(newId!),
    ).toBe(true);
    expect(composerFocus).toHaveBeenCalledTimes(1);
  });

  test("silent suppresses the haptic and sound but still clears panel payloads", () => {
    useViewerStore.setState({
      activeMessageFiles: {
        messageId: "msg-1",
        attachments: [],
      },
    });
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction, {
      silent: true,
    });

    expect(hapticLight).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
    expect(useViewerStore.getState().activeMessageFiles).toBeNull();
  });

  test("keeps an open app in the side-by-side layout with the new draft", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    const newId = useConversationStore.getState().activeConversationId;
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(newId);
    expect(composerFocus).toHaveBeenCalledTimes(1);
  });
});

describe("keepOpenAppBesideConversation", () => {
  test("binds the conversation and enters the split when an app is on screen", () => {
    openAppViewer();
    expect(keepOpenAppBesideConversation("conv-4")).toBe(true);
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-4",
    );
    expect(useViewerStore.getState().mainView).toBe("app-editing");
  });

  test("is a no-op when no app is loaded", () => {
    useViewerStore.setState({ mainView: "app" });
    expect(keepOpenAppBesideConversation("conv-4")).toBe(false);
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
  });

  test("is a no-op for overlay views", () => {
    useViewerStore.setState({
      mainView: "document",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
    });
    expect(keepOpenAppBesideConversation("conv-4")).toBe(false);
    expect(useViewerStore.getState().mainView).toBe("document");
  });
});

describe("revealConversationView", () => {
  test("returns to chat when nothing is keeping the app", () => {
    revealConversationView("conv-4");
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("keeps the app instead of returning to chat", () => {
    openAppViewer("app-editing");
    revealConversationView("conv-4");
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-4",
    );
  });
});
