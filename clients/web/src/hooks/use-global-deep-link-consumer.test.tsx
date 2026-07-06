import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";
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

const resetStores = () => {
  useViewerStore.setState({ mainView: "chat" });
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore.getState().reset();
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
      publish("deeplink.unknown", { url: "x" });
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });
});
