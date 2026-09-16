import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNavigate } from "react-router";

import { currentLocation, wrapperAt } from "@/hooks/router-probe.test-helper";
import { showPath } from "@/stores/open-app.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import { useAppViewerRouteHandlers } from "./use-app-viewer-route-handlers";

// The real stores are driven through `setState` because Bun module mocks are
// process-global: mocking a core store here leaks into every other test file.
let viewerSnapshot: ReturnType<typeof useViewerStore.getState>;
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;

const CONV_ID = "conv-app";
const APP_ID = "app-7";
const APP_PATH = routes.conversation(CONV_ID, APP_ID);
const CONVERSATION_PATH = routes.conversation(CONV_ID);
const LIBRARY_PATH = "/assistant/library";

function renderHandlers() {
  return renderHook(
    () => ({
      handlers: useAppViewerRouteHandlers(),
      navigate: useNavigate(),
    }),
    { wrapper: wrapperAt(APP_PATH) },
  );
}

beforeEach(() => {
  // `closeAppRoute` reads `window.location`, which the probe router does not
  // drive: without this the route branch of the close is never taken.
  showPath(APP_PATH);
  viewerSnapshot = useViewerStore.getState();
  conversationSnapshot = useConversationStore.getState();
  useConversationStore.setState({ activeConversationId: CONV_ID });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
});

describe("useAppViewerRouteHandlers", () => {
  test("closing lands on the conversation the app was open in", () => {
    const { result } = renderHandlers();

    act(() => result.current.handlers.handleCloseApp());

    expect(currentLocation().pathname).toBe(CONVERSATION_PATH);
  });

  test("closing follows the route the app is open on, not the selected conversation", () => {
    useConversationStore.setState({ activeConversationId: "conv-elsewhere" });
    const { result } = renderHandlers();

    act(() => result.current.handlers.handleCloseApp());

    expect(currentLocation().pathname).toBe(CONVERSATION_PATH);
  });

  test("a link out of the app lands on its href", () => {
    const { result } = renderHandlers();

    act(() => result.current.handlers.handleNavigateAppRoute(LIBRARY_PATH));

    expect(currentLocation().pathname).toBe(LIBRARY_PATH);
  });

  test("closing replaces the app entry when nothing recorded where it opened", () => {
    const { result } = renderHandlers();

    act(() => result.current.handlers.handleCloseApp());
    act(() => {
      void result.current.navigate(-1);
    });

    expect(currentLocation().pathname).not.toBe(APP_PATH);
  });

  test("the callbacks keep their identity across renders", () => {
    const { result, rerender } = renderHandlers();
    const first = result.current.handlers;

    rerender();

    expect(result.current.handlers.handleCloseApp).toBe(first.handleCloseApp);
    expect(result.current.handlers.handleNavigateAppRoute).toBe(
      first.handleNavigateAppRoute,
    );
  });
});
