/**
 * The app viewer's history, exercised through the real pieces: a memory
 * router, the real viewer store and its daemon-backed load, the real
 * `useAppRouteSync`, the real open and close helpers, and the real
 * `useConversationLoader` on the routes a test asks for it.
 *
 * What the seams here are for: the daemon POST can be held open, so a test can
 * leave the URL while a load is in flight and settle it afterwards, the daemon
 * GET answers empty so the loader's list and transcript reads ask nobody, and
 * the window is mirrored from the router, since the imperative helpers read
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import {
  createMemoryRouter,
  NavigationType,
  RouterProvider,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { LocationMirror } from "@/hooks/router-probe.test-helper";
import { liveViewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { carriedAppEntryState } from "@/utils/app-navigation";
import { hasAutoSendPromptState } from "@/utils/auto-send-prompt";
import {
  closeAppRoute,
  currentEntryState,
  navigateToConversation,
} from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { useAppRouteSync } from "./use-app-route-sync";
import { useAppViewerRouteHandlers } from "./use-app-viewer-route-handlers";
import { useConversationLoader } from "./use-conversation-loader";
import { useOpenAppFromChat } from "./use-open-app-from-chat";

const ASSISTANT_ID = "asst-1";
const APP_ID = "app-1";
const CONV_ID = "c1";
const OTHER_CONV_ID = "c2";
const DRAFT_CONV_ID = "draft-1";
/** The id the daemon mints for the draft's first message. */
const SERVER_CONV_ID = "conv-server-1";
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

/**
 * The conversation route under the loader the chat page mounts, for the tests
 * that need a URL naming a retired draft resolved to its server row. The
 * loader sits above `ConversationRoute`, so the mirror inside it writes the
 * window before the loader reads it, which is the order the real window is
 * already in.
 */
function ConversationRouteWithLoader() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  useConversationLoader({
    assistantId,
    assistantStateKind: "active",
    activeConversationId: conversationId ?? null,
    urlConversationId: conversationId ?? null,
    searchParams: new URLSearchParams(),
    activeConversation: undefined,
    refreshEpoch: 0,
    reachabilityReadyEpoch: 0,
    onboardingDraftConversationIdRef: createRef<string | null>() as {
      current: string | null;
    },
  });

  return <ConversationRoute />;
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

function renderHistory(
  initialEntries: string[],
  options?: { withLoader?: boolean },
) {
  const element =
    options?.withLoader === true ? (
      <ConversationRouteWithLoader />
    ) : (
      <ConversationRoute />
    );
  const router = createMemoryRouter(
    [
      { path: LIBRARY_PATH, element: <LibraryStandIn /> },
      { path: routes.conversation(":conversationId"), element },
      { path: routes.conversation(":conversationId", ":appId"), element },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
  /* Every read the loader mounts, answered empty: this suite is about the
     history entries, not about what a conversation holds. */
  spyOn(daemonClient, "get").mockImplementation((async () => ({
    data: { conversations: [], messages: [], hasMore: false },
    error: null,
    response: new Response("{}", { status: 200 }),
  })) as unknown as typeof daemonClient.get);
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

type TestRouter = ReturnType<typeof renderHistory>;

/** What the chat page hands an app action: its navigate and the entry it is on. */
function appActionContext(router: TestRouter) {
  return {
    navigate: router.navigate,
    isMobile: false,
    state: router.state.location.state,
  };
}

/** Counts the entries `run` pushes, for a move that is meant to push none. */
async function pushesDuring(
  router: TestRouter,
  run: () => Promise<void>,
): Promise<number> {
  let pushes = 0;
  const unsubscribe = router.subscribe((state) => {
    if (state.historyAction === NavigationType.Push) {
      pushes++;
    }
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return pushes;
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

  test("a failed load pops the entry the open recorded", async () => {
    holdOpens = true;
    const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

    click("Open app");
    await waitFor(() => expect(pendingOpens).toHaveLength(1));
    await act(async () => {
      pendingOpens[0].reject();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Pop);

    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(LIBRARY_PATH);

    router.dispose();
  });

  test("a reload that joined the request in flight pops once", async () => {
    holdOpens = true;
    const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

    click("Open app");
    await waitFor(() => expect(pendingOpens).toHaveLength(1));
    // The second click lands on the app's own route, so it reloads in place
    // and joins the request the route sync started.
    click("Open app");
    await waitFor(() =>
      expect(useViewerStore.getState().appLoad).not.toBeNull(),
    );
    expect(openRequests).toBe(1);
    expect(pendingOpens).toHaveLength(1);

    await act(async () => {
      pendingOpens[0].reject();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Pop);

    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(LIBRARY_PATH);

    router.dispose();
  });

  test("a failed load on a deep-linked app replaces its entry", async () => {
    holdOpens = true;
    const router = renderHistory([APP_PATH]);

    await waitFor(() => expect(pendingOpens).toHaveLength(1));
    await act(async () => {
      pendingOpens[0].reject();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Replace);

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

  test("relays from the app stay on its entry and the close still pops", async () => {
    const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();
    const opened = {
      appEntry: { appId: APP_ID, returnTo: CONVERSATION_PATH },
    };
    expect(router.state.location.state).toEqual(opened);

    const pushes = await pushesDuring(router, async () => {
      for (const prompt of ["one", "two"]) {
        await act(async () => {
          handleAppViewerAction(appActionContext(router), "relay_prompt", {
            prompt,
          });
        });
      }
    });

    // Each relay stands in for the entry it is dispatched from, so the stack
    // is the depth the open left it at and Back reaches no earlier relay.
    expect(pushes).toBe(0);
    expect(router.state.location.pathname).toBe(APP_PATH);
    expect(router.state.location.search).toContain("prompt=two");
    expect(router.state.location.search).toContain("relay=");
    expect(hasAutoSendPromptState(router.state.location.state)).toBe(true);
    expect(router.state.location.state).toMatchObject(opened);

    await act(async () => {
      handleAppViewerAction(appActionContext(router), "set_view", {
        view: "chat",
      });
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(CONVERSATION_PATH),
    );
    expect(router.state.historyAction).toBe(NavigationType.Pop);

    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(LIBRARY_PATH);

    router.dispose();
  });

  test("a relay into a new conversation closes onto the conversation it started", async () => {
    const router = renderHistory([LIBRARY_PATH, CONVERSATION_PATH]);

    click("Open app");
    await waitForAppOpen();

    await act(async () => {
      handleAppViewerAction(appActionContext(router), "relay_prompt", {
        prompt: "start something",
        conversation: "new",
      });
    });
    const draftId = useConversationStore.getState().activeConversationId;
    expect(draftId).not.toBe(CONV_ID);
    expect(router.state.location.pathname).toBe(
      routes.conversation(draftId!, APP_ID),
    );

    /* The draft's first send mints the row's id, records the replacement, and
       rewrites this entry in place, re-keying what the entry records to the
       conversation it now names. */
    await act(async () => {
      const conversation = useConversationStore.getState();
      conversation.recordDraftReplacement(draftId!, SERVER_CONV_ID);
      conversation.setActiveConversationId(SERVER_CONV_ID);
      void router.navigate(routes.conversation(SERVER_CONV_ID, APP_ID), {
        replace: true,
        state: carriedAppEntryState(currentEntryState(), SERVER_CONV_ID),
      });
    });

    await act(async () => {
      handleAppViewerAction(appActionContext(router), "set_view", {
        view: "chat",
      });
    });

    /* The relay started this conversation, so the close stays on it. A pop
       would land on the conversation the app was opened from and leave the
       one the user is talking in reachable only by Forward. */
    await waitFor(() =>
      expect(router.state.historyAction).toBe(NavigationType.Replace),
    );
    expect(router.state.location.pathname).toBe(
      routes.conversation(SERVER_CONV_ID),
    );

    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(CONVERSATION_PATH);

    router.dispose();
  });

  test("an entry naming a retired draft is redirected in place and still pops on close", async () => {
    const router = renderHistory(
      [LIBRARY_PATH, routes.conversation(DRAFT_CONV_ID)],
      { withLoader: true },
    );

    click("Open app");
    await waitForAppOpen();
    expect(router.state.location.pathname).toBe(
      routes.conversation(DRAFT_CONV_ID, APP_ID),
    );

    /* The user leaves, so the app entry is historical by the time the draft's
       first send comes back with the row's id. The send records the
       replacement and rewrites the active view, which is no longer this
       entry, so the entry still names the draft. */
    await act(async () => router.navigate(LIBRARY_PATH));
    expect(await screen.findByText("Library")).toBeDefined();
    act(() => {
      useConversationStore
        .getState()
        .recordDraftReplacement(DRAFT_CONV_ID, SERVER_CONV_ID);
    });

    await act(async () => router.navigate(-1));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        routes.conversation(SERVER_CONV_ID, APP_ID),
      ),
    );
    expect(router.state.location.state).toEqual({
      appEntry: {
        appId: APP_ID,
        returnTo: routes.conversation(SERVER_CONV_ID),
      },
    });

    click("Close app");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        routes.conversation(SERVER_CONV_ID),
      ),
    );

    /* The close popped, so the entry behind is the one the open was pushed
       from. A replace would have left the retired draft there, and Back would
       redirect onto the row already on screen. */
    await act(async () => router.navigate(-1));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(LIBRARY_PATH),
    );

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
