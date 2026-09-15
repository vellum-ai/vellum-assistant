import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  MemoryRouter,
  type NavigateFunction,
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";

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
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import {
  openDocumentFromChat,
  useOpenAppFromChat,
} from "./use-open-app-from-chat";

// We can't safely `mock.module(...)` core stores like viewer/conversation
// because Bun module mocks are process-global. They leak into every
// other test file in the run (the message-reconciliation suite would
// suddenly find `useConversationStore.setState` undefined). Instead we
// drive the real stores via `setState` and `getState`, capturing pre-test
// snapshots in `beforeEach` so we can restore them in `afterEach`.

let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;
let selectionSnapshot: ReturnType<typeof useResolvedAssistantsStore.getState>;

let lightSpy: ReturnType<typeof spyOn<typeof haptic, "light">>;

const loadAppMock = mock(async (_assistantId: string, _appId: string) => true);
const loadDocumentMock = mock(
  async (_assistantId: string, _surfaceId: string) => {},
);
const enterAppEditingMock = mock(() => undefined);
const exitAppEditingMock = mock(() => undefined);
const setEditingConversationIdMock = mock((_id: string | null) => undefined);

const ASSISTANT_ID = "asst-1";
const APP_ID = "app-1";
const OTHER_APP_ID = "app-2";
const CONV_ID = "conv-1";
const OTHER_CONV_ID = "conv-2";
const CHAT_PATH = routes.conversation(CONV_ID);
const APP_PATH = routes.conversation(CONV_ID, APP_ID);
const OTHER_CHAT_PATH = routes.conversation(OTHER_CONV_ID);
const OTHER_APP_PATH = routes.conversation(OTHER_CONV_ID, APP_ID);
const OTHER_CONV_OTHER_APP_PATH = routes.conversation(
  OTHER_CONV_ID,
  OTHER_APP_ID,
);
const NON_CHAT_PATH = routes.library.root;

// Renders the hook beside the router's location, so a test reads where the
// open landed from `result.current.pathname` instead of the router internals.
// The hook reads the live route from `window.location`, which the probe router
// does not drive, so the two start on the same path.
function renderOpenApp(initialPath: string) {
  window.history.replaceState(null, "", initialPath);
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      children,
    );
  }
  return renderHook(
    () => ({
      openApp: useOpenAppFromChat(),
      navigate: useNavigate(),
      pathname: useLocation().pathname,
      navigationType: useNavigationType(),
    }),
    { wrapper: Wrapper },
  );
}

/** Moves both routes the hook straddles: the probe router's and the window's. */
function goTo(navigate: NavigateFunction, path: string): void {
  window.history.replaceState(null, "", path);
  void navigate(path);
}

beforeEach(() => {
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  selectionSnapshot = useResolvedAssistantsStore.getState();

  lightSpy = spyOn(haptic, "light").mockImplementation(async () => {});

  mobileRef.current = false;
  loadAppMock.mockReset();
  loadDocumentMock.mockReset();
  enterAppEditingMock.mockReset();
  exitAppEditingMock.mockReset();
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
    return true;
  });

  useViewerStore.setState({
    mainView: "chat",
    activeAppId: null,
    openedAppState: null,
    loadApp: loadAppMock as unknown as typeof viewerSnapshot.loadApp,
    loadDocument:
      loadDocumentMock as unknown as typeof viewerSnapshot.loadDocument,
    enterAppEditing: enterAppEditingMock,
    exitAppEditing: exitAppEditingMock,
  });
  useConversationStore.setState({
    activeConversationId: null,
    draftConversationIds: new Set(),
    setEditingConversationId:
      setEditingConversationIdMock as unknown as typeof conversationSnapshot.setEditingConversationId,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
});

afterEach(() => {
  cleanup();
  lightSpy.mockRestore();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useResolvedAssistantsStore.setState(selectionSnapshot, true);
});

describe("useOpenAppFromChat", () => {
  test("no-ops when there is no active assistant", async () => {
    // GIVEN no assistant is selected
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const { result } = renderOpenApp(CHAT_PATH);

    // WHEN a surface asks to open an app
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN nothing happens: no load, no viewer mutation, no navigation
    expect(loadAppMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
    expect(result.current.pathname).toBe(CHAT_PATH);
  });

  test("navigates to the app route for the conversation on screen", async () => {
    // GIVEN a conversation is on screen
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderOpenApp(CHAT_PATH);

    // WHEN the user opens an app
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the URL names the app and `useAppRouteSync` owns the load, so
    // browser Back closes the app
    expect(result.current.pathname).toBe(APP_PATH);
    expect(loadAppMock).not.toHaveBeenCalled();
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("mints a draft conversation to carry the app when none is on screen", async () => {
    // GIVEN nothing is on screen for the app segment to hang off
    const { result } = renderOpenApp(routes.assistant);

    // WHEN the user opens an app
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN a fresh draft is selected and registered, and its app route is
    // what we land on
    const draftId = useConversationStore.getState().activeConversationId;
    expect(typeof draftId).toBe("string");
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId!),
    ).toBe(true);
    expect(result.current.pathname).toBe(routes.conversation(draftId!, APP_ID));
    expect(loadAppMock).not.toHaveBeenCalled();
  });

  // LUM-2691: off a chat route the click came from Library, Home or the
  // inspector, and `activeConversationId` names whatever the SSE and attention
  // consumers keep it on rather than anything the user is looking at.
  test("mints a draft for an open off a chat route", async () => {
    // GIVEN a conversation selected behind a route that is not the chat
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderOpenApp(NON_CHAT_PATH);

    // WHEN the user opens an app from there
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the app hangs off a fresh draft, so the selected conversation is
    // not resurfaced behind it
    const draftId = useConversationStore.getState().activeConversationId;
    expect(draftId).not.toBe(CONV_ID);
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId!),
    ).toBe(true);
    expect(result.current.pathname).toBe(routes.conversation(draftId!, APP_ID));
  });

  // LUM-2553: opening an app is a view action, so the entry point must not
  // decide the layout. It lands full width from the split as it does from
  // chat, matching an open from Home / Library.
  test("drops the split view on the way in", async () => {
    // GIVEN the viewer is in the chat+app split
    useConversationStore.setState({ activeConversationId: CONV_ID });
    useViewerStore.setState({ mainView: "app-editing" });
    const { result } = renderOpenApp(CHAT_PATH);

    // WHEN the user opens an app
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the app lands full width at its route
    expect(exitAppEditingMock).toHaveBeenCalledTimes(1);
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(result.current.pathname).toBe(APP_PATH);
  });

  test("opens the same way on a mobile viewport", async () => {
    // GIVEN a phone-sized viewport, in the split
    mobileRef.current = true;
    useConversationStore.setState({ activeConversationId: CONV_ID });
    useViewerStore.setState({ mainView: "app-editing" });
    const { result } = renderOpenApp(CHAT_PATH);

    // WHEN the user opens an app
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the layout does not depend on the viewport either
    expect(exitAppEditingMock).toHaveBeenCalledTimes(1);
    expect(enterAppEditingMock).not.toHaveBeenCalled();
    expect(result.current.pathname).toBe(APP_PATH);
  });

  test("reloads in place when the URL already names the app", async () => {
    // GIVEN the app is already open at its own route
    useConversationStore.setState({ activeConversationId: CONV_ID });
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user clicks it again
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN there is nowhere to navigate, so the app refetches in place, which
    // is how an app the assistant edited picks up its new HTML
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
    expect(result.current.pathname).toBe(APP_PATH);
  });

  test("reloads in place without minting a draft", async () => {
    // GIVEN the app's own route is on screen with no conversation selected
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user clicks it again
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the app refetches in place and no draft is minted, so the subagent
    // / workflow / transcript stores behind it are left alone
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(useConversationStore.getState().draftConversationIds.size).toBe(0);
    expect(result.current.pathname).toBe(APP_PATH);
  });

  test("drops the app segment when an in-place reload gives up", async () => {
    // GIVEN the app at its own route is gone, so the viewer falls back to chat
    useConversationStore.setState({ activeConversationId: CONV_ID });
    loadAppMock.mockImplementation(async () => {
      useViewerStore.setState({
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      });
      return false;
    });
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user clicks it again
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the dead segment leaves the URL, and it leaves without a history
    // entry, so a refresh or a copied bookmark does not retry the app
    expect(result.current.pathname).toBe(CHAT_PATH);
    expect(result.current.navigationType).toBe(NavigationType.Replace);
  });

  test("drops the app segment from the conversation the user moved to", async () => {
    // GIVEN a reload of the app that is still in flight
    useConversationStore.setState({ activeConversationId: CONV_ID });
    let releaseLoad: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    loadAppMock.mockImplementation(async () => {
      await pending;
      useViewerStore.setState({
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      });
      return false;
    });
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user selects another conversation that keeps the app beside it,
    // and only then does the reload give up
    let open: Promise<void> | undefined;
    await act(async () => {
      open = result.current.openApp(APP_ID);
      goTo(result.current.navigate, OTHER_APP_PATH);
    });
    await act(async () => {
      releaseLoad?.();
      await open;
    });

    // THEN the dead segment leaves the conversation the user is on, not the
    // one the reload started from, and it leaves without a history entry
    expect(result.current.pathname).toBe(OTHER_CHAT_PATH);
    expect(result.current.navigationType).toBe(NavigationType.Replace);
  });

  test("leaves a route naming another app alone", async () => {
    // GIVEN a reload of the app that is still in flight
    useConversationStore.setState({ activeConversationId: CONV_ID });
    let releaseLoad: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    loadAppMock.mockImplementation(async () => {
      await pending;
      useViewerStore.setState({
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      });
      return false;
    });
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user moves to a route that names a different app, and only then
    // does the old reload give up
    let open: Promise<void> | undefined;
    await act(async () => {
      open = result.current.openApp(APP_ID);
      goTo(result.current.navigate, OTHER_CONV_OTHER_APP_PATH);
    });
    await act(async () => {
      releaseLoad?.();
      await open;
    });

    // THEN the stale failure leaves that route alone: the segment names an app
    // of its own, and `useAppRouteSync` answers for the load there
    expect(result.current.pathname).toBe(OTHER_CONV_OTHER_APP_PATH);
  });

  test("keeps the app route when the viewer still holds the app", async () => {
    // GIVEN a reload that resolves false while the viewer keeps the app behind
    // an overlay
    useConversationStore.setState({ activeConversationId: CONV_ID });
    loadAppMock.mockImplementation(async (_assistantId, appId) => {
      useViewerStore.setState({ activeAppId: appId });
      return false;
    });
    const { result } = renderOpenApp(APP_PATH);

    // WHEN the user clicks it again
    await act(async () => {
      await result.current.openApp(APP_ID);
    });

    // THEN the URL still names what the viewer holds
    expect(result.current.pathname).toBe(APP_PATH);
  });
});

describe("openDocumentFromChat", () => {
  test("buzzes and opens the document under the assistant it is given", async () => {
    await openDocumentFromChat("asst-other", "surface-42");

    expect(lightSpy).toHaveBeenCalledTimes(1);
    expect(loadDocumentMock).toHaveBeenCalledWith("asst-other", "surface-42");
    expect(loadAppMock).not.toHaveBeenCalled();
  });
});
