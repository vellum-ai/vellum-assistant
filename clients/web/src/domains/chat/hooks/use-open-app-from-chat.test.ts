import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
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

import {
  chooseSidebarOpenAppDestination,
  useOpenAppFromChat,
} from "./use-open-app-from-chat";

// We can't safely `mock.module(...)` core stores like viewer/conversation
// because Bun module mocks are process-global — they leak into every
// other test file in the run (the message-reconciliation suite would
// suddenly find `useConversationStore.setState` undefined). Instead we
// drive the real stores via `setState` and `getState`, capturing pre-test
// snapshots in `beforeEach` so we can restore them in `afterEach`.

let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;
let selectionSnapshot: ReturnType<
  typeof useResolvedAssistantsStore.getState
>;

const loadAppMock = mock(async (_assistantId: string, _appId: string) => {});
const enterAppEditingMock = mock(() => undefined);
const setEditingConversationIdMock = mock(
  (_id: string | null) => undefined,
);

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useResolvedAssistantsStore.getState();

  mobileRef.current = false;
  loadAppMock.mockReset();
  enterAppEditingMock.mockReset();
  setEditingConversationIdMock.mockReset();

  // Default: loadApp succeeds, leaving viewer state pointing at the
  // requested app (mirrors the real `loadApp` action's contract).
  loadAppMock.mockImplementation(async (_assistantId, appId) => {
    useViewerStore.setState({
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

  test("enters app-editing when an active conversation is present and load succeeds", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(setEditingConversationIdMock).toHaveBeenCalledWith("conv-7");
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
  });

  test("on a mobile viewport, loads + binds editing conversation but stays full-screen (no app-editing upgrade)", async () => {
    // Split chat+app doesn't fit on a phone — `loadApp` already left
    // `mainView` at `"app"` (full-screen), and we expect no upgrade to
    // `"app-editing"` even with an active conversation.
    mobileRef.current = true;
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    // The editing-conversation binding still happens — any later
    // "edit this app" affordance from mobile threads back to the right
    // conversation.
    expect(setEditingConversationIdMock).toHaveBeenCalledWith("conv-7");
    expect(enterAppEditingMock).not.toHaveBeenCalled();
  });

  test("loads the app but skips app-editing when no conversation is active", async () => {
    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
  });

  test("skips app-editing when a newer open superseded this one (activeAppId mismatch)", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    loadAppMock.mockImplementationOnce(async () => {
      // Simulate a newer call having already swapped the active app.
      useViewerStore.setState({
        activeAppId: "different-app",
        openedAppState: {
          appId: "different-app",
          dirName: "",
          name: "",
          html: "",
        },
      });
    });

    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledTimes(1);
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("skips app-editing when loadApp returns without populating openedAppState (load failed)", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    loadAppMock.mockImplementationOnce(async () => {
      useViewerStore.setState({ activeAppId: null, openedAppState: null });
    });

    const { result } = renderHook(() => useOpenAppFromChat());

    await result.current("app-42");

    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("with bindConversation: false, loads the app but never binds or enters editing", async () => {
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() =>
      useOpenAppFromChat({ bindConversation: false }),
    );

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
  });

  test("with bindConversation: false on mobile, loads the app but never binds", async () => {
    mobileRef.current = true;
    useConversationStore.setState({ activeConversationId: "conv-7" });
    const { result } = renderHook(() =>
      useOpenAppFromChat({ bindConversation: false }),
    );

    await result.current("app-42");

    expect(loadAppMock).toHaveBeenCalledWith("asst-1", "app-42");
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
  });
});

describe("chooseSidebarOpenAppDestination", () => {
  test("returns null on the chat index path (viewer mounts here via ConversationRedirect)", () => {
    expect(chooseSidebarOpenAppDestination("/assistant")).toBeNull();
    expect(chooseSidebarOpenAppDestination("/assistant/")).toBeNull();
  });

  test("returns null on a conversation route (viewer mounts under ChatPage)", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/conversations/abc"),
    ).toBeNull();
  });

  test("navigates to the chat index when off-chat (e.g. library)", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/library"),
    ).toBe("/assistant");
  });

  test("navigates to the chat index when off-chat from home", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/home"),
    ).toBe("/assistant");
  });

  test("inspector subpath counts as off-chat (viewer panel is not mounted under InspectPage)", () => {
    expect(
      chooseSidebarOpenAppDestination(
        "/assistant/conversations/abc/inspect",
      ),
    ).toBe("/assistant");
  });

  test("identity / settings paths route to the chat index", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/identity"),
    ).toBe("/assistant");
  });
});
