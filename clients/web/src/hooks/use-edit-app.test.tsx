import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import { type ReactElement, type ReactNode } from "react";
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

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
let selectionSnapshot: ReturnType<typeof useResolvedAssistantsStore.getState>;

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
const LIBRARY_PATH = "/assistant/library/app-42";
const CONVERSATION_PATH = `/assistant/conversations/${CONV_ID}`;

// Renders the router's current path into the DOM so tests can assert
// navigation via `screen` without reaching into router internals.
function LocationProbe(): ReactElement {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}
function currentPath(): string | null {
  return screen.getByTestId("pathname").textContent;
}
function wrapperAt(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    );
  };
}
const wrapper = wrapperAt(LIBRARY_PATH);

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useResolvedAssistantsStore.getState();

  mobileRef.current = false;
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
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useResolvedAssistantsStore.setState(selectionSnapshot, true);
});

describe("useEditApp", () => {
  test("no-ops when there is no active assistant", () => {
    // GIVEN no assistant is selected
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user tries to edit an app
    act(() => result.current(APP));

    // THEN nothing happens — no viewer mutation, binding, or navigation
    expect(openAppMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(currentPath()).toBe(LIBRARY_PATH);
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
    expect(currentPath()).toBe(routes.conversation(CONV_ID));
  });

  test("on a mobile viewport, binds the edit conversation and navigates but stays full-screen (no split)", () => {
    // GIVEN a phone-sized viewport where the chat+app split doesn't fit
    mobileRef.current = true;
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN the edit conversation is still bound and we navigate to it...
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(CONV_ID);
    expect(currentPath()).toBe(routes.conversation(CONV_ID));
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
    expect(currentPath()).toBe(routes.conversation(CONV_ID));
  });

  test("navigates to the edit conversation from an off-chat route even when its id is already the active conversation", () => {
    // GIVEN we're on the Library app route (which doesn't mount the viewer)
    // AND the chat store still holds this app's edit conversation as active
    // from a previous visit — so an id-only guard would wrongly skip nav
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderHook(() => useEditApp(), { wrapper });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN we still navigate to the conversation so the split view appears
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
    expect(currentPath()).toBe(CONVERSATION_PATH);
  });

  test("skips redundant navigation when already on the edit conversation route", () => {
    // GIVEN the user is already on this app's edit conversation route
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderHook(() => useEditApp(), {
      wrapper: wrapperAt(CONVERSATION_PATH),
    });

    // WHEN the user clicks Edit
    act(() => result.current(APP));

    // THEN the split view still opens but the path is unchanged
    expect(enterAppEditingMock).toHaveBeenCalledTimes(1);
    expect(currentPath()).toBe(CONVERSATION_PATH);
  });
});
