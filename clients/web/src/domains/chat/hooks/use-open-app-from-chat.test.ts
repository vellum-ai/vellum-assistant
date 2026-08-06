import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

// `mock.module` is safe for `use-is-mobile` because it's a pure
// derived-value hook (no module-local state). The mobile case is
// controlled per-test via the mutable `mobileRef.current` below; tests
// that don't touch it default to `false` (wide viewport).
const mobileRef = { current: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mobileRef.current,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

import { useOpenAppFromChat } from "./use-open-app-from-chat";

// We can't safely `mock.module(...)` core stores like viewer/conversation
// because Bun module mocks are process-global. They leak into every
// other test file in the run (the message-reconciliation suite would
// suddenly find `useConversationStore.setState` undefined). Instead we
// drive the real stores via `setState` and `getState`, capturing pre-test
// snapshots in `beforeEach` so we can restore them in `afterEach`.

let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;
let selectionSnapshot: ReturnType<typeof useResolvedAssistantsStore.getState>;

const loadAppMock = mock(async (_assistantId: string, _appId: string) => {});
const enterAppEditingMock = mock(() => undefined);
const setEditingConversationIdMock = mock((_id: string | null) => undefined);

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useResolvedAssistantsStore.getState();

  mobileRef.current = false;
  loadAppMock.mockReset();
  enterAppEditingMock.mockReset();
  setEditingConversationIdMock.mockReset();

  // Default: loadApp succeeds, leaving viewer state pointing at the
  // requested app in the full-width `"app"` view (mirrors the real
  // `loadApp` action's contract, which sets `mainView` up front).
  loadAppMock.mockImplementation(async (_assistantId, appId) => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: appId,
      openedAppState: {
        appId,
        dirName: "",
        name: "",
        html: "",
      },
    });
  });

  useViewerStore.setState({
    // Start from the split view so each test proves the hook leaves the
    // viewer full-width rather than merely never leaving `"app"`.
    mainView: "app-editing",
    activeAppId: null,
    openedAppState: null,
    loadApp: loadAppMock as unknown as typeof viewerSnapshot.loadApp,
    enterAppEditing: enterAppEditingMock,
  });
  useConversationStore.setState({
    activeConversationId: null,
    setEditingConversationId:
      setEditingConversationIdMock as unknown as typeof conversationSnapshot.setEditingConversationId,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useResolvedAssistantsStore.setState(selectionSnapshot, true);
});

describe("useOpenAppFromChat", () => {
  test("no-ops when there is no active assistant", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  // LUM-2553: opening an app is a view action, so the entry point must not
  // decide the layout. A wide viewport with an active conversation is the
  // one combination that could justify the `app-editing` split, and it
  // still lands full-width, matching an open from Home / Library.
  test("stays full-width with an active conversation on a wide viewport", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("stays full-width with an active conversation on a mobile viewport", async () => {
    mobileRef.current = true;
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("stays full-width when no conversation is active", async () => {
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("leaves the viewer alone when the load fails", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    // The real `loadApp` falls back to chat when the open request fails.
    loadAppMock.mockImplementationOnce(async () => {
      useViewerStore.setState({
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      });
    });

    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });
});
