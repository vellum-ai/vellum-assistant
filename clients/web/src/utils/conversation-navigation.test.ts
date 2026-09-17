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
 * dismissing it to chat, and names it in the URL it navigates to.
 *
 * `navigateFromApp` is the other direction: a link followed from inside an
 * app leaves a chat destination to the route sync and closes the viewer
 * itself for any destination that unmounts the chat page.
 *
 * `closeAppRoute` is how every close affordance leaves an app: it closes the
 * viewer, drops the split binding, and lands on the conversation URL without
 * the app segment. It pops back through the entry the open recorded when that
 * entry is the one behind this app, and replaces the app's own entry in every
 * other case. `dropAppFromRoute` takes the same decision for a segment the
 * viewer already let go of, reading the recording off the entry on screen.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  appEntryStateFor,
  SAMPLE_APP,
  showOpenAppRoute,
  showPath,
} from "@/stores/open-app.test-helper";
import { carriedAppEntryState } from "@/utils/app-navigation";
import { hasAutoSendPromptState } from "@/utils/auto-send-prompt";
import { navigateDouble } from "@/utils/conversation-navigation.test-helper";
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
  closeAppRoute,
  dropAppFromRoute,
  exitAppSplit,
  navigateToConversation,
  navigateToNewConversation,
  keepOpenAppBesideConversation,
  keptAppId,
  navigateFromApp,
  revealConversationView,
} = await import("@/utils/conversation-navigation");

/** The conversation whose route holds the app the viewer shows. */
const OPEN_CONVERSATION = "conv-open";

function openAppViewer(view: "app" | "app-editing" = "app"): void {
  showOpenAppRoute({ conversationId: OPEN_CONVERSATION, mainView: view });
}

function openOverlayOverApp(): void {
  useViewerStore.setState({
    mainView: "document",
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
  showPath(routes.assistant);
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

  test("chat-info settles back to the app it was opened over, which then keeps the conversation beside it", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    useViewerStore.setState({
      mainView: "chat-info",
      viewBeforeChatInfo: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
      activeChatInfo: {
        assistantId: "asst-1",
        conversationId: "conv-1",
        category: null,
      },
    });
    showPath(routes.conversation("conv-1", SAMPLE_APP.appId));
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-2");

    // The payload clear runs before the reveal, so the reveal sees the app
    // the panel was opened over rather than the panel itself.
    expect(useViewerStore.getState().activeChatInfo).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-2",
    );
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
    expect(navigate).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9/app/app-1",
    );
  });

  test("a kept app rides along in front of the message anchor", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-9", {
      messageId: "msg-9",
    });

    expect(navigate).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9/app/app-1?message=msg-9",
    );
  });

  test("an overlay view is not a kept app, so the URL stays plain", () => {
    openOverlayOverApp();
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-9");

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
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-9"));
  });
});

describe("navigateToNewConversation", () => {
  test("resets panel payloads and process stores, taps, focuses the composer", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("new_conversation");
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

  test("sound: false drops the sound, keeping the tap, navigation, and focus", () => {
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction, {
      sound: false,
    });

    expect(playSound).not.toHaveBeenCalled();
    expect(hapticLight).toHaveBeenCalledTimes(1);
    const newId = useConversationStore.getState().activeConversationId;
    expect(newId).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith(routes.conversation(newId!));
    expect(composerFocus).toHaveBeenCalledTimes(1);
  });

  test("keeps an open app in the side-by-side layout with the new draft", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    const newId = useConversationStore.getState().activeConversationId;
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(newId);
    expect(composerFocus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      `/assistant/conversations/${newId}/app/app-1`,
    );
  });

  test("a kept app sits in the path and the prompt stays in the query", () => {
    openAppViewer();
    const navigate = mock((_to: string, _options?: { state?: unknown }) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction, {
      prompt: "hi there",
    });

    const newId = useConversationStore.getState().activeConversationId;
    const [to] = navigate.mock.calls[0];
    expect(to).toBe(
      routes.conversationWithPrompt(newId!, "hi there", undefined, "app-1"),
    );
    expect(to).toContain(`/assistant/conversations/${newId}/app/app-1?`);
  });

  test("a prompt rides the URL with the in-app auto-send marker in history state", () => {
    const navigate = mock((_to: string, _options?: { state?: unknown }) => {});
    const draftId = navigateToNewConversation(
      navigate as unknown as NavigateFunction,
      { prompt: "hello there" },
    );

    const [to, options] = navigate.mock.calls[0];
    expect(to).toBe(routes.conversationWithPrompt(draftId, "hello there"));
    expect(hasAutoSendPromptState(options?.state)).toBe(true);
  });

  test("without a prompt the navigation carries no auto-send marker", () => {
    const navigate = mock((_to: string, _options?: { state?: unknown }) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    const [, options] = navigate.mock.calls[0];
    expect(hasAutoSendPromptState(options?.state)).toBe(false);
  });
});

describe("keptAppId", () => {
  test("names the app the viewer keeps on screen", () => {
    openAppViewer();
    expect(keptAppId()).toBe("app-1");
  });

  test("names the app in the side-by-side layout too", () => {
    openAppViewer("app-editing");
    expect(keptAppId()).toBe("app-1");
  });

  test("is null when the viewer shows the chat", () => {
    expect(keptAppId()).toBeNull();
  });

  test("is null for an overlay view", () => {
    openOverlayOverApp();
    expect(keptAppId()).toBeNull();
  });

  test("is null when the URL names no app, whatever the store holds", () => {
    openAppViewer();
    showPath(routes.conversation(OPEN_CONVERSATION));

    expect(keptAppId()).toBeNull();
  });

  test("is null when the URL names some other app", () => {
    openAppViewer();
    showPath(routes.conversation(OPEN_CONVERSATION, "app-2"));

    expect(keptAppId()).toBeNull();
  });

  test("names the app behind a remote-gateway ingress basename", () => {
    openAppViewer();
    showPath(
      `/assistant-123${routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId)}`,
    );

    expect(keptAppId()).toBe(SAMPLE_APP.appId);
  });

  test("names the app the URL names", () => {
    openAppViewer();

    expect(keptAppId()).toBe(SAMPLE_APP.appId);
  });
});

describe("closeAppRoute", () => {
  test("closes the viewer, drops the split binding, lands on the route's conversation", () => {
    openAppViewer("app-editing");
    useConversationStore.getState().setEditingConversationId(OPEN_CONVERSATION);
    useConversationStore.getState().setActiveConversationId("conv-elsewhere");
    const navigate = navigateDouble();

    closeAppRoute(navigate);

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(useViewerStore.getState().openedAppState).toBeNull();
    expect(useConversationStore.getState().editingConversationId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });

  test("closes a viewer the URL never named", () => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
    });
    showPath(routes.conversation("conv-7"));
    const navigate = navigateDouble();

    closeAppRoute(navigate);

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-7"), {
      replace: true,
    });
  });

  test("falls back to the selected conversation when the URL names none", () => {
    openAppViewer();
    showPath(routes.assistant);
    useConversationStore.getState().setActiveConversationId("conv-5");
    const navigate = navigateDouble();

    closeAppRoute(navigate);

    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-5"), {
      replace: true,
    });
  });

  test("mints a draft without entering the split when neither names one", () => {
    openAppViewer();
    showPath(routes.assistant);
    const realEnterAppEditing = useViewerStore.getState().enterAppEditing;
    const enterAppEditing = mock(() => {});
    useViewerStore.setState({ enterAppEditing });
    const navigate = navigateDouble();

    try {
      closeAppRoute(navigate);
    } finally {
      useViewerStore.setState({ enterAppEditing: realEnterAppEditing });
    }

    const draftId = useConversationStore.getState().activeConversationId;
    expect(draftId).toBeTruthy();
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId!),
    ).toBe(true);
    expect(enterAppEditing).not.toHaveBeenCalled();
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(routes.conversation(draftId!), {
      replace: true,
    });
  });

  test("pops back to the entry the open recorded", () => {
    openAppViewer();
    const navigate = navigateDouble();

    closeAppRoute(navigate, { state: appEntryStateFor(OPEN_CONVERSATION) });

    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test("pops when the recording was re-keyed onto the conversation the URL names", () => {
    // The shape a draft's first send leaves: the open recorded a return to the
    // draft, and the rewrite re-keyed that return to the id the server gave.
    openAppViewer();
    const navigate = navigateDouble();

    closeAppRoute(navigate, {
      state: carriedAppEntryState(
        appEntryStateFor("draft-1"),
        OPEN_CONVERSATION,
      ),
    });

    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test("replaces when the recorded entry names another conversation or app", () => {
    openAppViewer();
    const navigate = navigateDouble();

    closeAppRoute(navigate, { state: appEntryStateFor("conv-elsewhere") });
    closeAppRoute(navigate, {
      state: appEntryStateFor(OPEN_CONVERSATION, "app-other"),
    });

    for (const call of navigate.mock.calls) {
      expect(call).toEqual([
        routes.conversation(OPEN_CONVERSATION),
        { replace: true },
      ]);
    }
  });

  test("replace: true forces the replace past a recorded entry", () => {
    openAppViewer();
    const navigate = navigateDouble();

    closeAppRoute(navigate, {
      state: appEntryStateFor(OPEN_CONVERSATION),
      replace: true,
    });

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
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
    openOverlayOverApp();
    expect(keepOpenAppBesideConversation("conv-4")).toBe(false);
    expect(useViewerStore.getState().mainView).toBe("document");
  });

  test("is a no-op when the URL names no app, whatever the store holds", () => {
    // A route that unmounted the chat page left the viewer on the app, and
    // nobody is looking at it.
    openAppViewer();
    showPath(routes.library.root);

    expect(keepOpenAppBesideConversation("conv-4")).toBe(false);
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
  });
});

describe("exitAppSplit", () => {
  test("gives the app the full width back and drops the bound pane", () => {
    openAppViewer("app-editing");
    useConversationStore.getState().setEditingConversationId("conv-4");

    exitAppSplit();

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
  });

  test("leaves a full-width app and its binding alone", () => {
    openAppViewer();
    useConversationStore.getState().setEditingConversationId("conv-4");

    exitAppSplit();

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-4",
    );
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

describe("navigateFromApp", () => {
  test("leaves the viewer to the route sync for a conversation destination", () => {
    openAppViewer("app-editing");
    useConversationStore.getState().setEditingConversationId("conv-2");
    const navigate = mock((_to: string) => {});
    const href = routes.conversation("conv-2");
    navigateFromApp(navigate as unknown as NavigateFunction, href);

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useViewerStore.getState().activeAppId).toBe(SAMPLE_APP.appId);
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-2",
    );
    expect(navigate).toHaveBeenCalledWith(href);
  });

  test("leaves the viewer alone for a conversation app-route destination", () => {
    openAppViewer("app-editing");
    useConversationStore.getState().setEditingConversationId("conv-2");
    const navigate = mock((_to: string) => {});
    const href = routes.conversation("conv-2", SAMPLE_APP.appId);
    navigateFromApp(navigate as unknown as NavigateFunction, href);

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useViewerStore.getState().activeAppId).toBe(SAMPLE_APP.appId);
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-2",
    );
    expect(navigate).toHaveBeenCalledWith(href);
  });

  test("closes the app for a destination that unmounts the chat page", () => {
    openAppViewer("app-editing");
    useConversationStore.getState().setEditingConversationId("conv-2");
    const navigate = mock((_to: string) => {});
    navigateFromApp(
      navigate as unknown as NavigateFunction,
      routes.library.root,
    );

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(useViewerStore.getState().openedAppState).toBeNull();
    expect(useConversationStore.getState().editingConversationId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(routes.library.root);
  });

  test("closes an app the URL never named for a chat destination", () => {
    // The route sync reacts to the app segment leaving the URL, and there is
    // no segment here to lose.
    useViewerStore.setState({
      mainView: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
    });
    showPath(routes.conversation("conv-1"));
    useConversationStore.getState().setEditingConversationId("conv-1");
    const navigate = mock((_to: string) => {});
    const href = routes.conversation("conv-2");
    navigateFromApp(navigate as unknown as NavigateFunction, href);

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(useConversationStore.getState().editingConversationId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(href);
  });

  test("classifies by pathname, so a query string keeps the app", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    const href = `${routes.conversation("conv-2")}?prompt=hi`;
    navigateFromApp(navigate as unknown as NavigateFunction, href);

    expect(useViewerStore.getState().activeAppId).toBe(SAMPLE_APP.appId);
    expect(navigate).toHaveBeenCalledWith(href);
  });

  test("classifies by pathname, so a query string still closes the app", () => {
    openAppViewer();
    const navigate = mock((_to: string) => {});
    const href = `${routes.library.root}?tab=apps`;
    navigateFromApp(navigate as unknown as NavigateFunction, href);

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(navigate).toHaveBeenCalledWith(href);
  });
});

describe("dropAppFromRoute", () => {
  test("replaces the app segment away once the viewer let the app go", () => {
    showPath(routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId));
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });

  test("leaves the URL alone while the viewer still holds the app", () => {
    openOverlayOverApp();
    showPath(routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId));
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).not.toHaveBeenCalled();
  });

  test("leaves the URL alone when it moved on to another app", () => {
    showPath(routes.conversation(OPEN_CONVERSATION, "app-2"));
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).not.toHaveBeenCalled();
  });

  test("evenIfHeld drops the segment while the viewer still holds the app", () => {
    openOverlayOverApp();
    showPath(routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId));
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId, { evenIfHeld: true });

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });

  test("still leaves a URL that moved on to another app alone", () => {
    openOverlayOverApp();
    showPath(routes.conversation(OPEN_CONVERSATION, "app-2"));
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId, { evenIfHeld: true });

    expect(navigate).not.toHaveBeenCalled();
  });

  test("pops the entry the open recorded", () => {
    showPath(
      routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId),
      appEntryStateFor(OPEN_CONVERSATION),
    );
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test("replaces when the recording names another conversation", () => {
    showPath(
      routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId),
      appEntryStateFor("conv-other"),
    );
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });

  test("replaces when the recording names another app", () => {
    showPath(
      routes.conversation(OPEN_CONVERSATION, SAMPLE_APP.appId),
      appEntryStateFor(OPEN_CONVERSATION, "app-2"),
    );
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId);

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });

  test("replace forces the replace over a recorded entry", () => {
    showOpenAppRoute({
      conversationId: OPEN_CONVERSATION,
      entryState: appEntryStateFor(OPEN_CONVERSATION),
    });
    const navigate = navigateDouble();

    dropAppFromRoute(navigate, SAMPLE_APP.appId, {
      evenIfHeld: true,
      replace: true,
    });

    expect(navigate).toHaveBeenCalledWith(
      routes.conversation(OPEN_CONVERSATION),
      { replace: true },
    );
  });
});
