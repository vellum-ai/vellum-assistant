import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Capacitor } from "@capacitor/core";
import type { BackButtonListener } from "@capacitor/app";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import type * as ConversationQueries from "@/hooks/conversation-queries";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { subscribeAndroidBackButtonSource } from "@/runtime/event-sources/android-back-button";
import type { DocumentContent } from "@/types/document-types";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

import { navigateToDocumentConversation } from "../document-conversation-navigation";
import { useUnseenDocumentChangesStore } from "../unseen-document-changes-store";
import type * as ConversationHistory from "./use-conversation-history";
import type * as TurnTimeout from "./use-turn-timeout";
import { DocumentChatContent } from "../components/document-chat-content";
import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";
import { trackDocumentSave } from "../api/document-save";

const nativeApp = await import("@capacitor/app");
let backButtonHandler: BackButtonListener | undefined;
const minimizeApp = mock(async () => {});
mock.module(
  "@capacitor/app",
  (): Partial<typeof nativeApp> => ({
    App: {
      ...nativeApp.App,
      addListener: async (_name, handler) => {
        backButtonHandler = handler as BackButtonListener;
        return { remove: async () => {} };
      },
      minimizeApp,
    },
  }),
);

const documentData: DocumentContent = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Notes",
  content: "Body",
  wordCount: 1,
  createdAt: 1,
  updatedAt: 1,
};
const load = mock(async () => ({ data: documentData }));
const resolveConversation = mock(
  async ({ path }: { path: { id: string } }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }),
);
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => "ready",
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: mock(() => {}),
}));
mock.module(
  "@/hooks/conversation-queries",
  (): Partial<typeof ConversationQueries> => ({
    useCanQueryDaemon: () => false,
    useConversationListQuery: () => ({
      conversations: [],
      isLoading: false,
      isPending: true,
      isError: false,
      error: null,
      hasData: false,
      hasMore: false,
      refetch: () => {},
    }),
  }),
);
mock.module(
  "./use-conversation-history",
  (): Partial<typeof ConversationHistory> => ({
    useConversationHistory: () => ({
      pagination: {
        messages: [],
        latestPage: undefined,
        subagentNotifications: undefined,
        backgroundToolCompletions: undefined,
        isLoading: false,
        isSuccess: false,
        isError: false,
        error: null,
        hasMore: false,
        isFetchingOlderPages: false,
        isFetching: false,
        fetchOlderPage: () => {},
        invalidate: async () => {},
        removeCache: () => {},
        latestPageOldestTimestamp: null,
        oldestLoadedTimestamp: null,
        dataUpdatedAt: 0,
      },
    }),
  }),
);
mock.module(
  "./use-turn-timeout",
  (): Partial<typeof TurnTimeout> => ({
    useTurnTimeout: () => {},
  }),
);
const { useConversationLoader } = await import("./use-conversation-loader");
const { useDocumentConversationRoute } =
  await import("./use-document-conversation-route");

function Harness() {
  const { conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const onboardingDraftConversationIdRef = useRef<string | null>(null);
  useConversationLoader({
    assistantId: "assistant-1",
    assistantStateKind: "active",
    activeConversationId: useConversationStore.use.activeConversationId(),
    urlConversationId: conversationId ?? null,
    searchParams,
    activeConversation: undefined,
    refreshEpoch: 0,
    reachabilityReadyEpoch: 0,
    onboardingDraftConversationIdRef,
  });
  const session = useDocumentConversationRoute();
  const editorRef = useRef<DocumentViewerContainerHandle>(null);
  const location = useLocation();
  return (
    <div data-slot="active-chat-view">
      <div data-testid="url">
        {location.pathname}
        {location.search}
        {location.hash}
      </div>
      <div data-testid="status">
        {session.isLoading ? "loading" : (session.error ?? "ready")}
      </div>
      {session.error || session.isLoading ? (
        <DocumentChatContent
          assistantId="assistant-1"
          surfaceId={session.surfaceId}
          document={null}
          loading={session.isLoading}
          error={session.error}
          editorRef={editorRef}
          onClose={session.closeDocument}
          onRetry={session.reloadDocument}
          onSubmitFeedback={() => {}}
        />
      ) : (
        <>
          <button onClick={session.closeDocument}>Close</button>
          <button onClick={session.reloadDocument}>Retry</button>
        </>
      )}
      <button onClick={session.viewConversation}>View conversation</button>
      <button onClick={session.reopenDocument}>Reopen document</button>
    </div>
  );
}

function LibraryEntry() {
  const navigate = useNavigate();
  return (
    <button
      data-testid="library"
      onClick={() =>
        navigateToDocumentConversation(
          navigate,
          documentData,
          "conv-1",
          "assistant-1",
        )
      }
    >
      Open document
    </button>
  );
}

function renderRoute(
  conversationId = "conv-1",
  showingDocument = true,
  fromLibrary = false,
  returnTo = "/assistant/library",
  initialEntry?: string,
) {
  const queryClient = new QueryClient();
  return render(
    <MemoryRouter
      initialEntries={[
        initialEntry ??
          (fromLibrary
            ? "/assistant/library"
            : `/assistant/conversations/${conversationId}?document=surface-1&documentReturn=${encodeURIComponent(returnTo)}${showingDocument ? "" : "&documentView=chat"}`),
      ]}
    >
      <Routes>
        <Route
          path="/assistant/conversations/:conversationId"
          element={<Harness />}
        />
        <Route path="/assistant/library" element={<LibraryEntry />} />
        <Route
          path="/assistant/documents/:surfaceId"
          element={<div data-testid="entry-adapter" />}
        />
      </Routes>
    </MemoryRouter>,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let viewer: ReturnType<typeof useViewerStore.getState>;
let conversation: ReturnType<typeof useConversationStore.getState>;
const viewport = viewportAxesStub();
beforeEach(() => {
  backButtonHandler = undefined;
  minimizeApp.mockClear();
  viewport.set({ narrow: true, coarsePointer: true });
  selection = useResolvedAssistantsStore.getState();
  viewer = useViewerStore.getState();
  conversation = useConversationStore.getState();
  useConversationStore.setState({ activeConversationId: null });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  load.mockReset();
  load.mockImplementation(async () => ({ data: documentData }));
  resolveConversation.mockReset();
  resolveConversation.mockImplementation(async ({ path }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }));
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
    path: { id: string };
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      return load();
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return resolveConversation({ path: options.path });
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
});
afterEach(() => {
  cleanup();
  viewport.restore();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
  useConversationStore.setState(conversation, true);
});

describe("document conversation route", () => {
  test.each([
    {
      name: "chat-info",
      open: () =>
        useViewerStore
          .getState()
          .openChatInfo({
            assistantId: "assistant-1",
            conversationId: "conv-1",
          }),
      close: () => useViewerStore.getState().closeChatInfo(),
    },
    {
      name: "subagent-detail",
      open: () => useViewerStore.getState().openSubagentDetail("subagent-1"),
      close: () => useViewerStore.getState().closeSubagentDetail(),
    },
    {
      name: "app",
      open: () => useViewerStore.getState().openApp("app-1"),
      close: () => useViewerStore.getState().closeApp(),
    },
  ])(
    "desktop $name replacement clears document intent and does not reopen on remount",
    async ({ name, open, close }) => {
      viewport.set({ narrow: false, coarsePointer: false });
      const page = renderRoute(
        "conv-1",
        true,
        false,
        "/assistant/library",
        "/assistant/conversations/conv-1?document=surface-1&documentReturn=%2Fassistant%2Flibrary&documentView=document&keep=1#section",
      );
      await waitFor(() =>
        expect(page.getByTestId("status").textContent).toBe("ready"),
      );
      act(open);
      await waitFor(() =>
        expect(page.getByTestId("url").textContent).toBe(
          "/assistant/conversations/conv-1?keep=1#section",
        ),
      );
      expect(useViewerStore.getState().mainView).toBe(name);
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
      act(close);
      expect(useViewerStore.getState().mainView).toBe("chat");
      const cleanUrl = page.getByTestId("url").textContent!;
      page.unmount();
      renderRoute("conv-1", true, false, "/assistant/library", cleanUrl);
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(1);
      expect(useViewerStore.getState().mainView).toBe("chat");
    },
  );

  test("opening a desktop panel cancels a pending document load without replacing the panel later", async () => {
    viewport.set({ narrow: false, coarsePointer: false });
    let finishLoad!: (value: { data: DocumentContent }) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    const page = renderRoute();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => useViewerStore.getState().openSubagentDetail("subagent-1"));
    await waitFor(() =>
      expect(page.getByTestId("url").textContent).toBe(
        "/assistant/conversations/conv-1",
      ),
    );
    await act(async () => finishLoad({ data: documentData }));
    expect(useViewerStore.getState().mainView).toBe("subagent-detail");
    expect(useViewerStore.getState().activeSubagentId).toBe("subagent-1");
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test.each(["mobile", "transcript"])(
    "keeps the document session for a panel over %s",
    async (presentation) => {
      viewport.set({
        narrow: presentation === "mobile",
        coarsePointer: presentation === "mobile",
      });
      const page = renderRoute("conv-1", presentation !== "transcript");
      await waitFor(() =>
        expect(page.getByTestId("status").textContent).toBe("ready"),
      );
      const url = page.getByTestId("url").textContent;
      const document = useViewerStore.getState().openedDocumentState;
      act(() => useViewerStore.getState().openSubagentDetail("subagent-1"));
      await act(async () => {});
      expect(page.getByTestId("url").textContent).toBe(url);
      expect(useViewerStore.getState().openedDocumentState).toBe(document);
    },
  );

  test.each(["ready", "loading", "stacked overlay"])(
    "Android Back closes the %s document session through its return route",
    async (state) => {
      let resolveLoad!: (value: { data: DocumentContent }) => void;
      if (state === "loading") {
        load.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveLoad = resolve;
            }),
        );
      }
      spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      spyOn(Capacitor, "getPlatform").mockReturnValue("android");
      const historyBack = spyOn(window.history, "back").mockImplementation(
        () => {},
      );
      const unsubscribe = subscribeAndroidBackButtonSource();
      try {
        const page = renderRoute();
        await waitFor(() => expect(typeof backButtonHandler).toBe("function"));
        await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        if (state !== "loading") {
          await waitFor(() =>
            expect(page.getByTestId("status").textContent).toBe("ready"),
          );
        }
        if (state === "stacked overlay") {
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dialog.remove();
            }
          });
          page.container.append(dialog);
          await act(async () => backButtonHandler!({ canGoBack: false }));
          expect(dialog.isConnected).toBe(false);
          expect(useViewerStore.getState().mainView).toBe("document");
          expect(page.getByTestId("url").textContent).toContain(
            "document=surface-1",
          );
        }
        await act(async () => backButtonHandler!({ canGoBack: false }));
        await page.findByTestId("library");
        if (state === "loading") {
          await act(async () => resolveLoad({ data: documentData }));
        }
        expect(useViewerStore.getState().openedDocumentState).toBeNull();
        expect(useViewerStore.getState().mainView).toBe("chat");
        expect(minimizeApp).not.toHaveBeenCalled();
        expect(historyBack).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    },
  );

  test("Escape claimed by a child or used for IME cannot dismiss the document", async () => {
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    const claimed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    fireEvent(window, claimed);
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(page.getByTestId("url").textContent).toContain("document=surface-1");
    expect(useViewerStore.getState().mainView).toBe("document");
    act(() => useViewerStore.setState({ mainView: "message-files" }));
    const overlayEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, overlayEscape);
    expect(overlayEscape.defaultPrevented).toBe(false);
    expect(useViewerStore.getState().mainView).toBe("message-files");
    expect(page.getByTestId("url").textContent).toContain("document=surface-1");
    fireEvent.click(page.getByText("View conversation"));
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(page.getByTestId("url").textContent).toContain("documentView=chat");
  });

  test("a pending save does not block the loading surface's close action", async () => {
    let finishSave!: () => void;
    const save = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    trackDocumentSave(
      { assistantId: "assistant-1", surfaceId: "surface-1" },
      save,
    );
    try {
      const page = renderRoute();
      fireEvent.click(page.getByRole("button", { name: "Close document" }));
      await page.findByTestId("library");
      await act(async () => finishSave());
      expect(load).not.toHaveBeenCalled();
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
    } finally {
      await act(async () => finishSave());
    }
  });

  test("closing during linked conversation validation prevents a late document open", async () => {
    let finishLink!: () => void;
    resolveConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLink = () =>
            resolve({
              data: { conversation: { id: "conv-1" } },
              response: new Response(null, { status: 200 }),
            });
        }),
    );
    const page = renderRoute();
    await waitFor(() => expect(resolveConversation).toHaveBeenCalledTimes(1));
    fireEvent.click(page.getByRole("button", { name: "Close document" }));
    await page.findByTestId("library");
    await act(async () => finishLink());
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test.each(["offline", "not found"])(
    "the error surface can close a document after a %s response",
    async (reason) => {
      load.mockRejectedValueOnce(
        Object.assign(new Error(reason), {
          status: reason === "not found" ? 404 : undefined,
        }),
      );
      const origin = "/assistant/conversations/conv-1";
      const page = renderRoute("conv-1", true, false, origin);
      await page.findByRole("button", { name: "Retry" });
      const close = await page.findByRole("button", { name: "Close document" });
      expect(page.getByRole("button", { name: "Retry" })).toBeTruthy();
      fireEvent.click(close);
      await waitFor(() =>
        expect(page.getByTestId("url").textContent).toBe(origin),
      );
      expect(page.queryByRole("alert")).toBeNull();
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
      expect(useViewerStore.getState().mainView).toBe("chat");
      expect(useConversationStore.getState().activeConversationId).toBe(
        "conv-1",
      );
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  test("closing returns to the originating conversation with its trailing slash", async () => {
    const origin = "/assistant/conversations/conv-origin/";
    const page = renderRoute("conv-1", true, false, origin);
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    fireEvent.click(page.getByText("Close"));
    await waitFor(() =>
      expect(page.getByTestId("url").textContent).toBe(origin),
    );
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-origin",
    );
  });

  test("Library entry keeps its document intent when the chat loader mounts", async () => {
    const page = renderRoute("conv-1", true, true);
    fireEvent.click(page.getByText("Open document"));
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(page.getByTestId("url").textContent).toContain("document=surface-1");
    expect(page.getByTestId("url").textContent).toContain(
      "documentReturn=%2Fassistant%2Flibrary",
    );
    expect(useConversationStore.getState().activeConversationId).toBe("conv-1");
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(load).toHaveBeenCalledTimes(1);
  });
  test("loading a transcript with a reopen target does not mark the hidden document viewed", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surface-1");
    const page = renderRoute("conv-1", false);
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(page.getByTestId("url").textContent).toContain("documentView=chat");
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(
      useUnseenDocumentChangesStore
        .getState()
        .changedDocuments["conv-1"]?.has("surface-1"),
    ).toBe(true);
    fireEvent.click(page.getByText("Reopen document"));
    expect(
      useUnseenDocumentChangesStore.getState().changedDocuments["conv-1"],
    ).toBeUndefined();
  });
  test("refresh loads the document into the current linked session", async () => {
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      assistantId: "assistant-1",
      surfaceId: "surface-1",
      conversationId: "conv-1",
    });
    expect(useViewerStore.getState().mainView).toBe("document");
  });

  test("transcript and document presentation switches do not reload the editor", async () => {
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    const opened = useViewerStore.getState().openedDocumentState;
    fireEvent.click(page.getByText("View conversation"));
    expect(page.getByTestId("url").textContent).toContain("documentView=chat");
    expect(useViewerStore.getState().mainView).toBe("chat");
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surface-1");
    fireEvent.click(page.getByText("Reopen document"));
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(useViewerStore.getState().openedDocumentState).toBe(opened);
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      useUnseenDocumentChangesStore.getState().changedDocuments["conv-1"],
    ).toBeUndefined();
  });

  test("closing during refresh cannot reopen the document when the request settles", async () => {
    let resolveLoad!: (value: { data: DocumentContent }) => void;
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const page = renderRoute();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(page.getByRole("button", { name: "Close document" }));
    await page.findByTestId("library");
    await act(async () => resolveLoad({ data: documentData }));
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(page.queryByTestId("url")).toBeNull();
  });

  test("closing before the save wait settles skips the document request", async () => {
    const page = renderRoute();
    fireEvent.click(page.getByRole("button", { name: "Close document" }));
    await page.findByTestId("library");
    expect(load).not.toHaveBeenCalled();
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test("a document URL for a different conversation goes through the entry adapter", async () => {
    const page = renderRoute("conv-other");
    await page.findByTestId("entry-adapter");
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test("a failed load is retryable in the same session", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surface-1");
    load.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const page = renderRoute();
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toContain(
        "Unable to open",
      ),
    );
    expect(
      useUnseenDocumentChangesStore
        .getState()
        .changedDocuments["conv-1"]?.has("surface-1"),
    ).toBe(true);
    fireEvent.click(page.getByText("Retry"));
    await waitFor(() =>
      expect(page.getByTestId("status").textContent).toBe("ready"),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });
});
