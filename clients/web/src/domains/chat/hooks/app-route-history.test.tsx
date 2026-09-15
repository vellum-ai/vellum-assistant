/**
 * The app viewer's history, exercised through the real pieces: a memory
 * router, the real viewer store and its daemon-backed load, the real
 * `useAppRouteSync`, and the real open and close helpers.
 *
 * What the seams here are for: the daemon POST can be held open, so a test can
 * leave the URL while a load is in flight and settle it afterwards, and the
 * window is mirrored from the router, since the imperative helpers read
 * `window.location`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryRouter,
  NavigationType,
  RouterProvider,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { LocationMirror } from "@/hooks/router-probe.test-helper";
import { liveViewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  closeAppRoute,
  navigateToConversation,
} from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { useAppRouteSync } from "./use-app-route-sync";
import { useAppViewerRouteHandlers } from "./use-app-viewer-route-handlers";
import { useOpenAppFromChat } from "./use-open-app-from-chat";

const ASSISTANT_ID = "asst-1";
const APP_ID = "app-1";
const CONV_ID = "c1";
const OTHER_CONV_ID = "c2";
const LIBRARY_PATH = routes.library.root;
const CONVERSATION_PATH = routes.conversation(CONV_ID);
const APP_PATH = routes.conversation(CONV_ID, APP_ID);

/** An app-open request the test holds, to settle once the URL has moved. */
interface PendingOpen {
  appId: string;
  resolve: () => void;
  reject: () => void;
}

let pendingOpens: PendingOpen[];
let holdOpens: boolean;
let openRequests: number;

function appOpenBody(appId: string) {
  return {
    appId,
    dirName: "support-monitor",
    name: "Support Monitor",
    html: "<h1>App</h1>",
    origin: `https://${appId}.example`,
  };
}

/** The envelope the daemon returns for an app that is gone. */
const APP_GONE = {
  error: { code: "NOT_FOUND", message: `App not found: ${APP_ID}` },
};

function ConversationRoute() {
  const { conversationId, appId } = useParams<{
    conversationId: string;
    appId: string;
  }>();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const navigate = useNavigate();
  const location = useLocation();
  const openApp = useOpenAppFromChat();
  const { handleCloseApp } = useAppViewerRouteHandlers();

  useAppRouteSync(assistantId, conversationId ?? null, appId ?? null);

  return (
    <>
      <button onClick={() => void openApp(APP_ID)}>Open app</button>
      <button onClick={handleCloseApp}>Close app</button>
      <button
        onClick={() => closeAppRoute(navigate, { state: location.state })}
      >
        System back
      </button>
      <LocationMirror />
    </>
  );
}

function LibraryStandIn() {
  const openApp = useOpenAppFromChat();
  return (
    <>
      <span>Library</span>
      <button onClick={() => void openApp(APP_ID)}>
        Open app from Library
      </button>
      <LocationMirror />
    </>
  );
}

function renderHistory(initialEntries: string[]) {
  const router = createMemoryRouter(
    [
      { path: LIBRARY_PATH, element: <LibraryStandIn /> },
      {
        path: routes.conversation(":conversationId"),
        element: <ConversationRoute />,
      },
      {
        path: routes.conversation(":conversationId", ":appId"),
        element: <ConversationRoute />,
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const viewport = liveViewportAxesStub();
const viewerSnapshot = useViewerStore.getState();
const conversationSnapshot = useConversationStore.getState();
const selectionSnapshot = useResolvedAssistantsStore.getState();

beforeEach(() => {
  pendingOpens = [];
  holdOpens = false;
  openRequests = 0;
  viewport.set({ narrow: false, coarsePointer: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useConversationStore.setState({ activeConversationId: CONV_ID });
  spyOn(daemonClient, "post").mockImplementation((async (options: {
    url: string;
    path: { id: string };
  }) => {
    if (!options.url.endsWith("/apps/{id}/open")) {
      throw new Error(`Unexpected request: ${options.url}`);
    }
    openRequests++;
    const appId = options.path.id;
    if (!holdOpens) {
      return { data: appOpenBody(appId) };
    }
    return new Promise((resolve, reject) => {
      pendingOpens.push({
        appId,
        resolve: () => resolve({ data: appOpenBody(appId) }),
        reject: () => reject(APP_GONE),
      });
    });
  }) as unknown as typeof daemonClient.post);
});

afterEach(() => {
  cleanup();
  viewport.restore();
  mock.restore();
  useViewerStore.setState(viewerSnapshot, true);
  useConversationStore.setState(conversationSnapshot, true);
  useResolvedAssistantsStore.setState(selectionSnapshot, true);
});

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Waits for the app the URL names to be loaded into the viewer. */
async function waitForAppOpen(): Promise<void> {
  await waitFor(() =>
    expect(useViewerStore.getState().openedAppState).not.toBeNull(),
  );
}

describe("app route history", () => {
  test("Back closes the app and Forward reopens it from the route", async () => {
    const router = renderHistory([CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();
    expect(router.state.location.pathname).toBe(APP_PATH);

    await act(async () => router.navigate(-1));
    await waitFor(() =>
      expect(useViewerStore.getState().activeAppId).toBeNull(),
    );
    expect(router.state.location.pathname).toBe(CONVERSATION_PATH);
    expect(useViewerStore.getState().mainView).toBe("chat");

    await act(async () => router.navigate(1));
    await waitForAppOpen();
    expect(router.state.location.pathname).toBe(APP_PATH);
    expect(openRequests).toBe(2);

    router.dispose();
  });

  test("returning to an app whose request fails drops the segment, on one request", async () => {
    holdOpens = true;
    const router = renderHistory([CONVERSATION_PATH]);

    click("Open app");
    await waitFor(() => expect(pendingOpens).toHaveLength(1));

    await act(async () => router.navigate(LIBRARY_PATH));
    expect(await screen.findByText("Library")).toBeDefined();
    await act(async () => router.navigate(-1));
    await act(async () => {
      pendingOpens[0].reject();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    const viewer = useViewerStore.getState();
    expect(viewer.activeAppId).toBeNull();
    expect(viewer.openedAppState).toBeNull();
    expect(viewer.mainView).toBe("chat");
    expect(openRequests).toBe(1);

    router.dispose();
  });

  test("an abandoned request cannot close the app a newer one opened", async () => {
    holdOpens = true;
    const router = renderHistory([CONVERSATION_PATH]);

    click("Open app");
    await waitFor(() => expect(pendingOpens).toHaveLength(1));

    await act(async () => router.navigate(-1));
    await act(async () => router.navigate(1));
    await waitFor(() => expect(pendingOpens).toHaveLength(2));
    expect(openRequests).toBe(2);

    await act(async () => {
      pendingOpens[1].resolve();
      await Promise.resolve();
    });
    await waitForAppOpen();
    await act(async () => {
      pendingOpens[0].reject();
      await Promise.resolve();
    });

    expect(useViewerStore.getState().openedAppState).not.toBeNull();
    expect(router.state.location.pathname).toBe(APP_PATH);

    router.dispose();
  });

  test.each([false, true])(
    "closing an app opened from its conversation pops that entry (narrow: %p)",
    async (narrow) => {
      viewport.set({ narrow, coarsePointer: narrow });
      const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

      click("Open app");
      await waitForAppOpen();
      click("Close app");

      await waitFor(() =>
        expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
      );
      expect(router.state.historyAction).toBe(NavigationType.Pop);

      await act(async () => router.navigate(-1));
      expect(router.state.location.pathname).toBe(LIBRARY_PATH);

      router.dispose();
    },
  );

  test("closing an app opened from the Library replaces its entry", async () => {
    const router = renderHistory([LIBRARY_PATH]);

    click("Open app from Library");
    await waitForAppOpen();
    click("Close app");

    await waitFor(() =>
      expect(router.state.historyAction).toBe(NavigationType.Replace),
    );
    expect(useConversationStore.getState().activeConversationId).toBe(
      router.state.location.pathname.slice(`${routes.conversations}/`.length),
    );

    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(LIBRARY_PATH);

    router.dispose();
  });

  test("switching assistants under the app route reloads it", async () => {
    const router = renderHistory([CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();
    expect(openRequests).toBe(1);

    // A switch leaves this route mounted, so the app on screen would otherwise
    // stay the previous assistant's while every other action uses the new one.
    await act(async () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    await waitFor(() =>
      expect(useViewerStore.getState().openedAppState?.assistantId).toBe(
        "asst-2",
      ),
    );
    expect(openRequests).toBe(2);
    expect(router.state.location.pathname).toBe(APP_PATH);

    router.dispose();
  });

  test("Back between two conversations sharing an app re-binds the split", async () => {
    const router = renderHistory([CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();
    act(() => {
      navigateToConversation(router.navigate, OTHER_CONV_ID);
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        routes.conversation(OTHER_CONV_ID, APP_ID),
      ),
    );
    expect(useConversationStore.getState().editingConversationId).toBe(
      OTHER_CONV_ID,
    );

    await act(async () => router.navigate(-1));
    await waitFor(() =>
      expect(useConversationStore.getState().editingConversationId).toBe(
        CONV_ID,
      ),
    );
    expect(useViewerStore.getState().mainView).toBe("app-editing");

    await act(async () => router.navigate(-1));
    await waitFor(() =>
      expect(useViewerStore.getState().mainView).toBe("chat"),
    );
    expect(useConversationStore.getState().editingConversationId).toBeNull();

    router.dispose();
  });

  test("Android Back on a minimized app pops the entry the open recorded", async () => {
    viewport.set({ narrow: true, coarsePointer: true });
    const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();
    act(() => {
      useViewerStore.setState({ isAppMinimized: true });
    });
    click("System back");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Pop);

    router.dispose();
  });

  test("Android Back on an app opened by a direct link replaces its entry", async () => {
    viewport.set({ narrow: true, coarsePointer: true });
    const router = renderHistory([APP_PATH]);

    await waitForAppOpen();
    act(() => {
      useViewerStore.setState({ isAppMinimized: true });
    });
    click("System back");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Replace);

    router.dispose();
  });
});
