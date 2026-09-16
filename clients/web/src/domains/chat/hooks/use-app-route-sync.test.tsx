import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore, type OpenedAppState } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import { currentLocation, wrapperAt } from "@/hooks/router-probe.test-helper";
import { showPath } from "@/stores/open-app.test-helper";

import { useAppRouteSync } from "./use-app-route-sync";

// We can't safely `mock.module(...)` core stores like viewer/conversation
// because Bun module mocks are process-global. Instead we drive the real
// stores via `setState` / `getState`, restoring pre-test snapshots after.

let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;

const ASSISTANT_ID = "asst-1";
const APP_ID = "app-42";
const CONV_ID = "conv-1";
const APP_PATH = routes.conversation(CONV_ID, APP_ID);

const APP: OpenedAppState = {
  assistantId: ASSISTANT_ID,
  appId: APP_ID,
  dirName: "support-monitor",
  name: "Support Monitor",
  html: "<html></html>",
};

const loadAppMock = mock(async (_assistantId: string, _appId: string) => true);
const closeAppMock = mock(() => undefined);
const setMainViewMock = mock((_view: string) => undefined);
const setEditingConversationIdMock = mock((_id: string | null) => undefined);

const wrapper = wrapperAt(APP_PATH);

interface HookProps {
  assistantId: string | null;
  conversationId?: string | null;
  routeAppId: string | null;
}

function renderSync(props: HookProps) {
  return renderHook(
    ({ assistantId, conversationId = CONV_ID, routeAppId }: HookProps) =>
      useAppRouteSync(assistantId, conversationId, routeAppId),
    { wrapper, initialProps: props },
  );
}

beforeEach(() => {
  // The imperative helpers read `window.location`, which the probe router does
  // not drive.
  showPath(APP_PATH);
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();

  loadAppMock.mockReset();
  closeAppMock.mockReset();
  setMainViewMock.mockReset();
  setEditingConversationIdMock.mockReset();

  // Default: the load succeeds and leaves the viewer holding the app, which
  // mirrors the real `loadApp` contract.
  loadAppMock.mockImplementation(async (_assistantId, appId) => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: appId,
      openedAppState: { ...APP, appId },
    });
    return true;
  });

  useViewerStore.setState({
    mainView: "chat",
    activeAppId: null,
    openedAppState: null,
    loadApp: loadAppMock as unknown as typeof viewerSnapshot.loadApp,
    closeApp: closeAppMock,
    setMainView:
      setMainViewMock as unknown as typeof viewerSnapshot.setMainView,
  });
  useConversationStore.setState({
    activeConversationId: CONV_ID,
    setEditingConversationId:
      setEditingConversationIdMock as unknown as typeof conversationSnapshot.setEditingConversationId,
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
});

describe("useAppRouteSync", () => {
  test("loads the app the URL names when the viewer holds nothing", async () => {
    // GIVEN the viewer shows the chat and the URL names an app
    // WHEN the hook mounts
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the app is loaded exactly once, and the URL is left alone
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
    expect(currentLocation().pathname).toBe(APP_PATH);
  });

  test("leaves the split alone when the app the URL names is already loaded", async () => {
    // GIVEN the app is open beside its edit conversation
    useViewerStore.setState({
      mainView: "app-editing",
      activeAppId: APP_ID,
      openedAppState: APP,
    });

    // WHEN the hook mounts on that app's route
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN nothing is reloaded and the split survives
    expect(loadAppMock).not.toHaveBeenCalled();
    expect(setMainViewMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().mainView).toBe("app-editing");
  });

  test("reloads the app when it was loaded for another assistant", async () => {
    // GIVEN the viewer holding this app as the previous assistant's, which a
    // switch leaves behind on a route that stays mounted
    useViewerStore.setState({
      mainView: "app",
      activeAppId: APP_ID,
      openedAppState: { ...APP, assistantId: "asst-old" },
    });

    // WHEN the hook runs for the assistant that is active now
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the app the URL names is fetched again under that assistant
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
  });

  test("brings the app back in front when an overlay took the main view", () => {
    // GIVEN the loaded app is hidden behind the document overlay
    useViewerStore.setState({
      mainView: "document",
      activeAppId: APP_ID,
      openedAppState: APP,
    });

    // WHEN the hook mounts on that app's route
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the viewer returns to the app the URL still names
    expect(setMainViewMock).toHaveBeenCalledWith("app");
    expect(loadAppMock).not.toHaveBeenCalled();
  });

  test("leaves the app route when the store gave up on the app", async () => {
    // GIVEN the app is missing, so the store falls back to chat
    loadAppMock.mockImplementation(async () => {
      useViewerStore.setState({
        mainView: "chat",
        activeAppId: null,
        openedAppState: null,
      });
      return false;
    });

    // WHEN the hook mounts on that app's route
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the URL stops naming an app that cannot be opened
    await waitFor(() =>
      expect(currentLocation().pathname).toBe(routes.conversation(CONV_ID)),
    );
  });

  test("keeps the app route when the viewer left the app view mid-load", async () => {
    // GIVEN the load succeeds but an overlay took the main view meanwhile, so
    // the store still holds the app and reports it is not on screen
    loadAppMock.mockImplementation(async (_assistantId, appId) => {
      useViewerStore.setState({
        mainView: "document",
        activeAppId: appId,
        openedAppState: { ...APP, appId },
      });
      return false;
    });

    // WHEN the hook mounts on that app's route
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the URL is left alone: the app is still what the viewer holds
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    expect(currentLocation().pathname).toBe(APP_PATH);
  });

  test("does not reload the app when it re-renders on the same route", async () => {
    const { rerender } = renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));

    // WHEN the hook re-renders with the same assistant and app
    rerender({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the app is not fetched again
    expect(loadAppMock).toHaveBeenCalledTimes(1);
  });

  test("waits for the assistant to resolve before loading", async () => {
    // GIVEN the assistant has not resolved yet
    const { rerender } = renderSync({
      assistantId: null,
      routeAppId: APP_ID,
    });
    expect(loadAppMock).not.toHaveBeenCalled();

    // WHEN it resolves
    rerender({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });

    // THEN the app the URL names is loaded once
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
  });

  test("closes the app when the route stops naming it", async () => {
    // GIVEN the app the URL names is on screen
    const { rerender } = renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));

    // WHEN the route drops the app segment, as every close affordance does
    rerender({
      assistantId: ASSISTANT_ID,
      routeAppId: null,
    });

    // THEN the viewer lets the app go, and the split it was bound to with it
    expect(closeAppMock).toHaveBeenCalledTimes(1);
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(null);
  });

  test("closes an app the viewer still holds when mounting without the segment", () => {
    // GIVEN a viewer holding an app, landed on a plain conversation route
    useViewerStore.setState({
      mainView: "app",
      activeAppId: APP_ID,
      openedAppState: APP,
    });

    // WHEN the hook mounts there
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: null,
    });

    // THEN the URL wins: no segment means no app
    expect(closeAppMock).toHaveBeenCalledTimes(1);
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(null);
  });

  test("releases the app but leaves an overlay in front of it", () => {
    // GIVEN a document opened over the app, on a route naming no app
    useViewerStore.setState({
      mainView: "document",
      activeAppId: APP_ID,
      openedAppState: APP,
    });

    // WHEN the hook mounts there
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: null,
    });

    // THEN the app goes, and the overlay the user just opened stays in front
    const state = useViewerStore.getState();
    expect(state.mainView).toBe("document");
    expect(state.activeAppId).toBeNull();
    expect(state.openedAppState).toBeNull();
    expect(closeAppMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).toHaveBeenCalledWith(null);
  });

  test("joins a load already in flight", async () => {
    // GIVEN a request for this app already running, which left the viewer
    // naming the app with nothing loaded yet
    useViewerStore.setState({
      mainView: "app",
      activeAppId: APP_ID,
      openedAppState: null,
    });

    // WHEN a surface mounts onto that app's route
    renderSync({ assistantId: ASSISTANT_ID, routeAppId: APP_ID });

    // THEN it asks for the app, which the store answers with the running
    // request rather than a second one
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    expect(loadAppMock).toHaveBeenCalledWith(ASSISTANT_ID, APP_ID);
  });

  test("re-binds the split to the conversation the route names", async () => {
    // GIVEN the app open beside a conversation
    useConversationStore.setState({ editingConversationId: CONV_ID });
    const { rerender } = renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    setEditingConversationIdMock.mockReset();

    // WHEN Back lands on another conversation sharing the same app
    rerender({
      assistantId: ASSISTANT_ID,
      conversationId: "conv-2",
      routeAppId: APP_ID,
    });

    // THEN the chat pane follows the route, and the app is not reloaded
    expect(setEditingConversationIdMock).toHaveBeenCalledWith("conv-2");
    expect(loadAppMock).toHaveBeenCalledTimes(1);
  });

  test("leaves an unbound split alone", async () => {
    // GIVEN the app full width, with no chat pane bound beside it
    useConversationStore.setState({ editingConversationId: null });
    const { rerender } = renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: APP_ID,
    });
    await waitFor(() => expect(loadAppMock).toHaveBeenCalledTimes(1));
    setEditingConversationIdMock.mockReset();

    // WHEN the route moves to another conversation carrying the same app
    rerender({
      assistantId: ASSISTANT_ID,
      conversationId: "conv-2",
      routeAppId: APP_ID,
    });

    // THEN no split is created out of a route change
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });

  test("does not touch the viewer when no app is open and none is routed", () => {
    // GIVEN the plain conversation route and a viewer showing the chat
    renderSync({
      assistantId: ASSISTANT_ID,
      routeAppId: null,
    });

    // THEN the hook stays out of the way of store-only surfaces
    expect(closeAppMock).not.toHaveBeenCalled();
    expect(setEditingConversationIdMock).not.toHaveBeenCalled();
  });
});
