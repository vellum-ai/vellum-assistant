import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
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
  typeof useAssistantSelectionStore.getState
>;

const loadAppMock = mock(async (_assistantId: string, _appId: string) => {});
const enterAppEditingMock = mock(() => undefined);
const setEditingConversationIdMock = mock(
  (_id: string | null) => undefined,
);

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useAssistantSelectionStore.getState();

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
  useAssistantSelectionStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useAssistantSelectionStore.setState(selectionSnapshot, true);
});

describe("useOpenAppFromChat", () => {
  test("no-ops when there is no active assistant", async () => {
    useAssistantSelectionStore.setState({ activeAssistantId: null });
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
});

describe("chooseSidebarOpenAppDestination", () => {
  test("returns null on the chat index path (viewer mounts here via ConversationRedirect)", () => {
    expect(chooseSidebarOpenAppDestination("/assistant", "conv-7")).toBeNull();
    expect(
      chooseSidebarOpenAppDestination("/assistant/", "conv-7"),
    ).toBeNull();
  });

  test("returns null on a conversation route (viewer mounts under ChatPage)", () => {
    expect(
      chooseSidebarOpenAppDestination(
        "/assistant/conversations/abc",
        "conv-7",
      ),
    ).toBeNull();
  });

  test("navigates to the active conversation when off-chat (e.g. library)", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/library", "conv-7"),
    ).toBe("/assistant/conversations/conv-7");
  });

  test("navigates to the chat index when off-chat with no active conversation", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/home", null),
    ).toBe("/assistant");
  });

  test("inspector subpath counts as off-chat (viewer panel is not mounted under InspectPage)", () => {
    expect(
      chooseSidebarOpenAppDestination(
        "/assistant/conversations/abc/inspect",
        "conv-7",
      ),
    ).toBe("/assistant/conversations/conv-7");
  });

  test("identity / settings paths route to the active conversation", () => {
    expect(
      chooseSidebarOpenAppDestination("/assistant/identity", "conv-7"),
    ).toBe("/assistant/conversations/conv-7");
  });
});
