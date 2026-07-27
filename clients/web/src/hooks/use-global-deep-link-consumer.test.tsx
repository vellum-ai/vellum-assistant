import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

const navigateMock = mock((_to: string) => undefined);
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

const ensureMainWindowVisibleMock = mock(async () => undefined);
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
// Full Sentry surface — `mock.module` is process-global in bun, so a
// partial mock would shadow `captureException` (used by `runtime/event-sources/*`
// and `sse-service`) for every later test file in the run.
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

const { useGlobalDeepLinkConsumer } =
  await import("./use-global-deep-link-consumer");
const { drainPendingVoiceStartDeepLink } =
  await import("@/domains/chat/voice/live-voice/start-voice-deep-link");

const resetStores = () => {
  useViewerStore.setState({ mainView: "chat" });
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore.getState().reset();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  useAssistantIdentityStore.setState({ assistantId: null, version: null });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
};

/**
 * Make the live-voice eligibility gate pass: an assistant new enough to serve
 * live voice, with the identity version scoped to that same assistant.
 */
const seedEligibleAssistant = (version = "0.10.12") => {
  useAssistantIdentityStore.setState({ assistantId: "assistant-1", version });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
};

beforeEach(() => {
  __resetForTesting();
  __resetPendingDeepLinkForTesting();
  navigateMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  sentryBreadcrumbMock.mockClear();
  resetStores();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __resetPendingDeepLinkForTesting();
  resetStores();
});

describe("deeplink.send", () => {
  test("navigates to /assistant + parks the message in the pending store + ensures window", () => {
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.send", { message: "hi" });
    });

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "hi",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.openThread", () => {
  test("navigates to the conversation route + ensures window", () => {
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("resets the main view to chat so the thread isn't hidden behind the app viewer", () => {
    useViewerStore.setState({ mainView: "app" });
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
  });

  test("runs the full conversation-switch path — subagent/workflow resets + active id sync", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useWorkflowStore.setState({ orderedIds: ["wf-1"] });
    useConversationStore.setState({ activeConversationId: "old-conversation" });
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual([]);
    expect(useWorkflowStore.getState().orderedIds).toEqual([]);
    expect(useConversationStore.getState().activeConversationId).toBe(
      "abc-123",
    );
  });

  test("same-thread tap keeps live subagent/workflow state — the id doesn't change, so re-seed effects wouldn't re-run", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useWorkflowStore.setState({ orderedIds: ["wf-1"] });
    useConversationStore.setState({ activeConversationId: "abc-123" });
    useViewerStore.setState({ mainView: "app" });
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual(["sub-1"]);
    expect(useWorkflowStore.getState().orderedIds).toEqual(["wf-1"]);
    // Viewer reset + URL sync + window activation still apply.
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.billingCheckoutComplete", () => {
  test("success navigates to billing carrying the session id so the wizard opens", () => {
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "success",
        sessionId: "cs_test_a1B2",
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/settings/usage?tab=billing&session_id=cs_test_a1B2",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("cancel lands on the upgrade-cancel page — no session id, no wizard", () => {
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "cancel",
        sessionId: null,
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/settings/billing/upgrade/cancel",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.startVoice", () => {
  /** The drain awaits `whenAssistantVersionKnown`, so let microtasks settle. */
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test("mode=new starts a session on the draft composer — no conversation, so the server assigns one", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(starter);
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.startVoice", { mode: "new" });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("parks the request when no controller is mounted, and the drain starts it once a starter registers (cold launch)", async () => {
    seedEligibleAssistant();
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.startVoice", { mode: "new" });
    });
    await flush();

    // No starter yet — the request survives rather than being dropped.
    expect(usePendingDeepLinkStore.getState().pendingVoiceStart).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith("/assistant");

    // What `useLiveVoiceSessionController` does when it mounts.
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(starter);
    await act(async () => {
      await drainPendingVoiceStartDeepLink();
    });

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(usePendingDeepLinkStore.getState().pendingVoiceStart).toBe(false);
  });

  test("navigates but does not start when the assistant can't serve live voice", async () => {
    // Below `useSupportsLiveVoice`'s MIN_VERSION — the gate that replaced the
    // retired `voice-mode` flag, and the same one that hides the composer's
    // voice button.
    seedEligibleAssistant("0.10.11");
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(starter);
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.startVoice", { mode: "new" });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingVoiceStart).toBe(false);
  });

  test("mode=resume returns to the running session's conversation instead of starting a second one", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(starter);
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.startVoice", { mode: "resume" });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9",
    );
    expect(starter).not.toHaveBeenCalled();
  });

  test("mode=resume with nothing running falls through to a new session", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(starter);
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.startVoice", { mode: "resume" });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });
});

describe("deeplink.unknown", () => {
  test("Sentry breadcrumb only — no navigation or window activation", () => {
    renderHook(() => useGlobalDeepLinkConsumer());

    act(() => {
      publish("deeplink.unknown", { url: "javascript:alert(1)" });
    });

    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    const args = sentryBreadcrumbMock.mock.calls[0]?.[0] as {
      data?: { url?: string };
    };
    expect(args.data?.url).toBe("javascript:alert(1)");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });
});

describe("subscription lifecycle", () => {
  test("unmount unsubscribes — published events after unmount have no effect", () => {
    const { unmount } = renderHook(() => useGlobalDeepLinkConsumer());

    unmount();

    act(() => {
      publish("deeplink.send", { message: "post-unmount" });
      publish("deeplink.openThread", { threadId: "z" });
      publish("deeplink.startVoice", { mode: "new" });
      publish("deeplink.unknown", { url: "x" });
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
    expect(usePendingDeepLinkStore.getState().pendingVoiceStart).toBe(false);
  });
});
