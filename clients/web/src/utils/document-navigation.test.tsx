import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useImperativeHandle, useRef } from "react";
import {
  createMemoryRouter,
  NavigationType,
  RouterProvider,
} from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type * as OrgReadiness from "@/hooks/use-is-org-ready";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type * as Library from "@/domains/library/library-view";
import {
  documentEntryState,
  hasDocumentReturnEntry,
} from "@/utils/document-navigation";

import type * as Viewer from "@/domains/chat/components/document-viewer-container";
import { useOpenDocumentFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { useDocumentConversationRoute } from "@/domains/chat/hooks/use-document-conversation-route";
import { DocumentChatContent } from "@/domains/chat/components/document-chat-content";

mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof OrgReadiness> => ({
    useOrgHeaderReadiness: () => "ready",
  }),
);
mock.module(
  "@/domains/library/library-view",
  (): Partial<typeof Library> => ({
    LibraryView: ({ onOpenDocument }) => (
      <button onClick={() => onOpenDocument?.("surface-1")}>
        Open document
      </button>
    ),
  }),
);
mock.module(
  "@/domains/chat/components/document-viewer-container",
  (): Partial<typeof Viewer> => ({
    DocumentViewerContainer: ({ onClose, onSubmitFeedback, handleRef }) => {
      useImperativeHandle(handleRef, () => ({
        refreshComments: async () => {},
        flushPendingSave: async () => ({ title: "Notes", content: "Body" }),
        beginSendPreparation: () => ({
          flush: async () => ({ title: "Notes", content: "Body" }),
          isCurrent: () => true,
          release: () => {},
        }),
      }));
      return (
        <>
          <button onClick={onClose}>Close document</button>
          <button onClick={onSubmitFeedback}>Feedback</button>
        </>
      );
    },
  }),
);

const { LibraryPage } = await import("@/domains/library/library-page");
const { DocumentViewerPage } = await import("@/domains/chat/document-viewer-page");

function Conversation() {
  const entry = useOpenDocumentFromChat();
  const session = useDocumentConversationRoute();
  const document = useViewerStore.use.openedDocumentState();
  const editorRef = useRef<Viewer.DocumentViewerContainerHandle>(null);
  if (!session.surfaceId) {
    return (
      <button onClick={() => void entry("surface-1")}>Open document</button>
    );
  }
  return (
    <>
      <DocumentChatContent
        assistantId="assistant-1"
        surfaceId={session.surfaceId}
        document={document}
        loading={session.isLoading}
        error={session.error}
        editorRef={editorRef}
        onClose={session.closeDocument}
        onRetry={session.reloadDocument}
        onSubmitFeedback={() => {}}
      />
      <button onClick={session.viewConversation}>View conversation</button>
      <button onClick={session.reopenDocument}>Reopen document</button>
    </>
  );
}

const viewport = viewportAxesStub();
const selection = useResolvedAssistantsStore.getState();
const viewer = useViewerStore.getState();
const conversation = useConversationStore.getState();
const identity = useAssistantIdentityStore.getState();
let linked: boolean;
let documentConversationId: string;
let queryClient: QueryClient;
let documentLoads: number;

beforeEach(() => {
  viewport.set({ narrow: true, coarsePointer: true });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useAssistantIdentityStore.setState({
    assistantId: "assistant-1",
    version: "0.11.12",
  });
  useConversationStore.setState({ activeConversationId: null });
  window.sessionStorage.clear();
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  linked = true;
  documentConversationId = "conv-linked";
  documentLoads = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
    path: { id: string };
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      documentLoads++;
      return {
        data: {
          success: true,
          surfaceId: "surface-1",
          conversationId: documentConversationId,
          title: "Notes",
          content: "Body",
          wordCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return {
        data: { conversation: { id: options.path.id } },
        response: new Response(null, {
          status: linked || options.path.id === "conv-created" ? 200 : 404,
        }),
      };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
  spyOn(daemonClient, "post").mockImplementation((async (options: {
    url: string;
    body: { conversationId: string };
  }) => {
    if (options.url.endsWith("/documents/{id}/conversations")) {
      documentConversationId = options.body.conversationId;
      return { data: {} };
    }
    if (options.url.endsWith("/conversations")) {
      return { data: { id: "conv-created" } };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.post);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  viewport.restore();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
  useConversationStore.setState(conversation, true);
  useAssistantIdentityStore.setState(identity, true);
});

function renderHistory(initialEntries: string[]) {
  const router = createMemoryRouter(
    [
      { path: "/assistant", element: <div>Home</div> },
      { path: "/assistant/library", element: <LibraryPage /> },
      {
        path: "/assistant/documents/:surfaceId",
        element: <DocumentViewerPage />,
      },
      {
        path: "/assistant/conversations/:conversationId",
        element: <Conversation />,
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("document navigation history", () => {
  test.each([
    "/assistant/library",
    "/assistant/conversations/conv-origin",
    "/assistant/conversations/conv-origin/",
    "/assistant/conversations/conv-linked",
  ])(
    "closing a click-opened document pops its entry from %s",
    async (origin) => {
      const router = renderHistory(["/assistant", origin]);
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      await waitFor(() =>
        expect(useViewerStore.getState().openedDocumentState).not.toBeNull(),
      );
      const loads = documentLoads;
      const state = router.state.location.state;
      expect(hasDocumentReturnEntry(state, "surface-1", origin)).toBe(true);
      fireEvent.click(
        screen.getByRole("button", { name: "View conversation" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Reopen document" }));
      expect(router.state.location.state).toEqual(state);
      expect(documentLoads).toBe(loads);
      fireEvent.click(screen.getByRole("button", { name: "Close document" }));
      await waitFor(() => expect(router.state.location.pathname).toBe(origin));
      expect(router.state.location.search).toBe("");
      expect(router.state.historyAction).toBe(NavigationType.Pop);
      await act(async () => router.navigate(-1));
      expect(router.state.location.pathname).toBe("/assistant");
      router.dispose();
    },
  );

  test.each(["/assistant/library", "/assistant/conversations/conv-origin"])(
    "missing-link recovery preserves the return entry from %s",
    async (origin) => {
      linked = false;
      const router = renderHistory(["/assistant", origin]);
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Close document" }),
      );
      await waitFor(() => expect(router.state.location.pathname).toBe(origin));
      expect(router.state.historyAction).toBe(NavigationType.Pop);
      await act(async () => router.navigate(-1));
      expect(router.state.location.pathname).toBe("/assistant");
      router.dispose();
    },
  );

  test.each([
    "/assistant/documents/surface-1",
    "/assistant/conversations/conv-linked?document=surface-1",
  ])(
    "a cold link %s replaces itself with its safe return route",
    async (url) => {
      const router = renderHistory([url]);
      await waitFor(() =>
        expect(useViewerStore.getState().openedDocumentState).not.toBeNull(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Close document" }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/assistant/library"),
      );
      expect(router.state.historyAction).toBe(NavigationType.Replace);
      router.dispose();
    },
  );

  test.each(["Start a linked conversation", "Feedback"])(
    "%s during recovery keeps one document history entry",
    async (action) => {
      linked = false;
      const router = renderHistory(["/assistant", "/assistant/library"]);
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      fireEvent.click(await screen.findByRole("button", { name: action }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          "/assistant/conversations/conv-created",
        ),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Reopen document" }),
      );
      expect(
        hasDocumentReturnEntry(
          router.state.location.state,
          "surface-1",
          "/assistant/library",
        ),
      ).toBe(true);
      fireEvent.click(
        await screen.findByRole("button", { name: "Close document" }),
      );
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/assistant/library"),
      );
      expect(router.state.historyAction).toBe(NavigationType.Pop);
      await act(async () => router.navigate(-1));
      expect(router.state.location.pathname).toBe("/assistant");
      router.dispose();
    },
  );

  test.each(["prompt=send", "relay=again", "document=surface-2"])(
    "does not mark an unsafe or nested chat entry with %s",
    (search) => {
      const origin = "/assistant/conversations/conv-origin";
      expect(
        documentEntryState(
          { pathname: origin, search: `?${search}` },
          "surface-1",
        ),
      ).toBeUndefined();
    },
  );

  test("return metadata must match both the document and destination", () => {
    const state = documentEntryState(
      { pathname: "/assistant/library", search: "" },
      "surface-1",
    );
    expect(
      hasDocumentReturnEntry(state, "surface-2", "/assistant/library"),
    ).toBe(false);
    expect(
      hasDocumentReturnEntry(
        state,
        "surface-1",
        "/assistant/conversations/conv-origin",
      ),
    ).toBe(false);
    expect(
      hasDocumentReturnEntry(null, "surface-1", "/assistant/library"),
    ).toBe(false);
  });
});
