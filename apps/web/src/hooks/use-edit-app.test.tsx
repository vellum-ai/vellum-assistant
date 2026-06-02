import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

// `mock.module` is safe for `use-is-mobile` because it's a pure
// derived-value hook (no module-local state). The mobile case is
// controlled per-test via the mutable `mobileRef.current` below; tests
// that don't touch it default to `false` (wide viewport).
const mobileRef = { current: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mobileRef.current,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore, type OpenedAppState } from "@/stores/viewer-store";
import { setEditChatConversationId } from "@/utils/edit-chat-session";
import { routes } from "@/utils/routes";

import { useEditApp } from "./use-edit-app";

// We can't safely `mock.module(...)` core stores like viewer/conversation
// because Bun module mocks are process-global — they leak into every other
// test file in the run. Instead we drive the real stores via `setState` /
// `getState`, capturing pre-test snapshots so we can restore them after.

let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;
let selectionSnapshot: ReturnType<typeof useAssistantSelectionStore.getState>;

const openAppMock = mock((_appId: string) => undefined);
const setLoadedAppMock = mock((_app: OpenedAppState) => undefined);
const enterAppEditingMock = mock(() => undefined);
const setEditingConversationIdMock = mock((_id: string | null) => undefined);

const APP: OpenedAppState = {
  appId: "app-42",
  dirName: "support-monitor",
  name: "Support Monitor",
  html: "<html></html>",
};
const CONV_ID = "conv-edit";
const INITIAL_PATH = "/assistant/library/app-42";

// Records the router's current path so tests can assert navigation without
// reaching into router internals.
let lastPath = INITIAL_PATH;
function LocationProbe(): null {
  lastPath = useLocation().pathname;
  return null;
}
function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[INITIAL_PATH]}>
      {children}
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useAssistantSelectionStore.getState();

  mobileRef.current = false;
  lastPath = INITIAL_PATH;
  openAppMock.mockReset();
  setLoadedAppMock.mockReset();
  enterAppEditingMock.mockReset();
  setEditingConversationIdMock.mockReset();
  window.sessionStorage.clear();

  // Seed the per-app edit conversation so the resolved id is deterministic
  // (otherwise the hook mints a random UUID).
  setEditChatConversationId("asst-1", APP.appId, CONV_ID);

  useViewerStore.setState({
    activeAppId: null,
    openedAppState: null,
    openApp: openAppMock,
    setLoadedApp: setLoadedAppMock,
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
  window.sessionStorage.clear();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useAssistantSelectionStore.setState(selectionSnapshot, true);
});

describe("useEditApp", () => {
  test("no-ops when there is no active assistant", () => {
    // GIVEN no assistant is selected
    useAssistantSelectionStore.setState({ activeAssistantId: null });
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user tries to edit an app
    act(() => result.current(APP));

    // THEN nothing happens — no viewer mutation, binding, or navigation
    expect(openAppMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(lastPath).toBe(INITIAL_PATH);
  });

  test("loads the app into the viewer and opens the split edit view on desktop", () => {
    // GIVEN the viewer has no app loaded (e.g. the standalone Library view)
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN the app is loaded, bound to its edit conversation, the split
    // view opens, and we navigate to that conversation
    expect(openAppMock).toHaveBeenCalledWith(APP.appId);
    expect(setLoadedAppMock).toHaveBeenCalledWith(APP);
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(CONV_ID);
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
    expect(lastPath).toBe(routes.conversation(CONV_ID));
  });

  test("on a mobile viewport, binds the edit conversation and navigates but stays full-screen (no split)", () => {
    // GIVEN a phone-sized viewport where the chat+app split doesn't fit
    mobileRef.current = true;
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN the edit conversation is still bound and we navigate to it...
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(CONV_ID);
    expect(lastPath).toBe(routes.conversation(CONV_ID));
    // ...but the viewer is not upgraded to the split edit view
    expect(enterAppEditingMock).not.toHaveBeenCalled();
  });

  test("reuses the already-loaded app instead of reloading when the viewer already shows it", () => {
    // GIVEN the in-chat viewer already has this app open full-screen
    useViewerStore.setState({ activeAppId: APP.appId, openedAppState: APP });
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN it doesn't reload the app, just opens the split edit view
    expect(openAppMock).not.toHaveBeenCalled();
    expect(setLoadedAppMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
    expect(lastPath).toBe(routes.conversation(CONV_ID));
  });

  test("skips navigation when already on the edit conversation route", () => {
    // GIVEN the user is already viewing the edit conversation
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN the split view still opens but no redundant navigation occurs
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
    expect(lastPath).toBe(INITIAL_PATH);
  });
});
