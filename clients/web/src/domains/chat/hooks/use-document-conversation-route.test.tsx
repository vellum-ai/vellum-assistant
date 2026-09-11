import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import type { DocumentContent } from "@/types/document-types";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

import { navigateToDocumentConversation } from "../document-conversation-navigation";
import { useUnseenDocumentChangesStore } from "../unseen-document-changes-store";
import type * as ConversationHistory from "./use-conversation-history";
import type * as TurnTimeout from "./use-turn-timeout";

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
const sdk = await import("@/generated/daemon/sdk.gen");
const load = mock(async () => ({ data: documentData }));
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdk,
  documentsByIdGet: load,
  conversationsByIdGet: async ({ path }: { path: { id: string } }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }),
}));
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
  const location = useLocation();
  return (
    <>
      <div data-testid="url">
        {location.pathname}
        {location.search}
      </div>
      <div data-testid="status">
        {session.isLoading ? "loading" : (session.error ?? "ready")}
      </div>
      <button onClick={session.closeDocument}>Close</button>
      <button onClick={session.viewConversation}>View conversation</button>
      <button onClick={session.reopenDocument}>Reopen document</button>
      <button onClick={session.reloadDocument}>Retry</button>
    </>
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
) {
  const queryClient = new QueryClient();
  return render(
    <MemoryRouter
      initialEntries={[
        fromLibrary
          ? "/assistant/library"
          : `/assistant/conversations/${conversationId}?document=surface-1&documentReturn=${encodeURIComponent(returnTo)}${showingDocument ? "" : "&documentView=chat"}`,
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
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
  useConversationStore.setState(conversation, true);
});

describe("document conversation route", () => {
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
    expect(load).not.toHaveBeenCalled();
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
    fireEvent.click(page.getByText("Close"));
    await page.findByTestId("library");
    await act(async () => resolveLoad({ data: documentData }));
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(page.queryByTestId("url")).toBeNull();
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
