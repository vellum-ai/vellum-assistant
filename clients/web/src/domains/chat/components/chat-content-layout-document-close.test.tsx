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
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";

import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type * as OrgReadiness from "@/hooks/use-is-org-ready";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

import { showDocumentInConversation } from "../document-conversation-navigation";
import type { ChatMainPanelProps } from "./chat-route-content";

const documentData = {
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
let readiness: ReturnType<typeof OrgReadiness.useOrgHeaderReadiness> = "ready";
mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof OrgReadiness> => ({
    useOrgHeaderReadiness: () => readiness,
  }),
);
mock.module("./chat-route-content", () => ({
  ChatMainPanel: () => {
    const location = useLocation();
    const navigationType = useNavigationType();
    return (
      <div data-testid="url" data-navigation-type={navigationType}>
        {location.pathname}
        {location.search}
        {location.hash}
      </div>
    );
  },
}));
mock.module("./progress-stack", () => ({ ProgressStack: () => null }));
mock.module("./tiptap-document-editor", () => ({
  TiptapDocumentEditor: () => <div data-testid="editor" />,
}));
const comments = await import("../api/document-comments");
mock.module("../api/document-comments", () => ({
  ...comments,
  fetchComments: async () => [],
}));
const { ChatContentLayout } = await import("./chat-content-layout");
const viewport = viewportAxesStub();
const selection = useResolvedAssistantsStore.getState();
const viewer = useViewerStore.getState();
const conversation = useConversationStore.getState();

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>Browser Back</button>
      <button onClick={() => navigate(1)}>Browser Forward</button>
      <button onClick={() => navigate("/assistant/conversations/conv-2")}>
        Open another conversation
      </button>
    </>
  );
}

function renderLayout(url: string, previousEntries: string[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[...previousEntries, url]}>
        <HistoryControls />
        <Routes>
          <Route
            path="/assistant/conversations/:conversationId"
            element={<ChatContentLayout {...({} as ChatMainPanelProps)} />}
          />
          <Route path="/assistant/library" element={<div>Library</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...page, queryClient };
}

beforeEach(() => {
  readiness = "ready";
  viewport.set({ narrow: false, coarsePointer: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useConversationStore.setState({ activeConversationId: "conv-1" });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  load.mockReset();
  load.mockImplementation(async () => ({ data: documentData }));
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      return load();
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return {
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
});

afterEach(() => {
  cleanup();
  mock.restore();
  viewport.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
});

describe("desktop document drawer dismissal", () => {
  test.each([
    "ready",
    "loading",
    "resolving organization",
    "unavailable organization",
  ])(
    "browser Back clears the %s document before another conversation mounts",
    async (phase) => {
      if (phase === "resolving organization") {
        readiness = "resolving";
      } else if (phase === "unavailable organization") {
        readiness = "unavailable";
      }
      let finishLoad: (() => void) | undefined;
      if (phase === "loading") {
        load.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishLoad = () => resolve({ data: documentData });
            }),
        );
      }
      const page = renderLayout(
        "/assistant/conversations/conv-1?document=surface-1",
        ["/assistant/library"],
      );
      if (phase === "ready") {
        await screen.findByTestId("editor");
      } else if (phase === "loading") {
        await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      }
      fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
      await screen.findByText("Library");
      expect(useViewerStore.getState().mainView).toBe("chat");
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
      expect(useViewerStore.getState().activeDocumentTarget).toBeNull();
      await act(async () => finishLoad?.());
      fireEvent.click(
        screen.getByRole("button", { name: "Open another conversation" }),
      );
      expect(screen.getByTestId("url").textContent).toBe(
        "/assistant/conversations/conv-2",
      );
      expect(Boolean(screen.queryByTestId("editor"))).toBe(false);
      expect(useViewerStore.getState().mainView).toBe("chat");
      expect(load).toHaveBeenCalledTimes(readiness === "ready" ? 1 : 0);
      page.unmount();
      page.queryClient.clear();
    },
  );

  test("browser Forward restores a document after route-exit cleanup", async () => {
    const page = renderLayout(
      "/assistant/conversations/conv-1?document=surface-1",
      ["/assistant/library"],
    );
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    await screen.findByText("Library");
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browser Forward" }));
    await screen.findByTestId("editor");
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(load).toHaveBeenCalledTimes(2);
    page.unmount();
    page.queryClient.clear();
  });

  test.each([
    "same document",
    "other assistant",
    "other surface",
    "workspace preview",
  ])("route-exit cleanup preserves a newer owner: %s", async (replacement) => {
    const page = renderLayout(
      "/assistant/conversations/conv-1?document=surface-1",
    );
    await screen.findByTestId("editor");
    act(() => {
      if (replacement === "workspace preview") {
        useViewerStore.getState().openWorkspaceFilePreview("notes.txt", "text");
      } else {
        showDocumentInConversation(
          {
            ...documentData,
            surfaceId:
              replacement === "other surface" ? "surface-2" : "surface-1",
          },
          "conv-1",
          replacement === "other assistant" ? "assistant-2" : "assistant-1",
        );
      }
    });
    const nextOwner = useViewerStore.getState().openedDocumentState;
    const nextTarget = useViewerStore.getState().activeDocumentTarget;
    page.unmount();
    expect(useViewerStore.getState().openedDocumentState).toBe(nextOwner);
    expect(useViewerStore.getState().activeDocumentTarget).toBe(nextTarget);
    expect(useViewerStore.getState().mainView).toBe("document");
    page.queryClient.clear();
  });

  test("route-exit cleanup clears its document without dismissing another panel", async () => {
    const page = renderLayout(
      "/assistant/conversations/conv-1?document=surface-1",
    );
    await screen.findByTestId("editor");
    act(() => useViewerStore.getState().openApp("app-1"));
    page.unmount();
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(useViewerStore.getState().activeDocumentTarget).toBeNull();
    page.queryClient.clear();
  });

  test.each(["button", "Escape"])(
    "%s clears document URL intent and stays closed on reload",
    async (dismissal) => {
      const page = renderLayout(
        "/assistant/conversations/conv-1?document=surface-1&documentReturn=%2Fassistant%2Flibrary&documentView=document&keep=1#message-1",
      );
      await screen.findByTestId("editor");
      const close = await screen.findByRole("button", {
        name: "Close document",
      });
      if (dismissal === "button") {
        fireEvent.click(close);
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }
      const expected = "/assistant/conversations/conv-1?keep=1#message-1";
      await waitFor(() =>
        expect(screen.getByTestId("url").textContent).toBe(expected),
      );
      expect(screen.getByTestId("url").dataset.navigationType).toBe("REPLACE");
      expect(useViewerStore.getState().mainView).toBe("chat");
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
      expect(useViewerStore.getState().activeDocumentTarget).toBeNull();
      expect(useConversationStore.getState().activeConversationId).toBe(
        "conv-1",
      );
      page.unmount();
      page.queryClient.clear();
      const refreshed = renderLayout(expected);
      expect(
        screen.queryByRole("button", { name: "Close document" }),
      ).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
      refreshed.unmount();
      refreshed.queryClient.clear();
    },
  );

  test("a drawer opened without document URL intent closes without navigation", async () => {
    showDocumentInConversation(documentData, "conv-1", "assistant-1");
    const url = "/assistant/conversations/conv-1?keep=1#message-1";
    const page = renderLayout(url);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close document" }),
    );
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(screen.getByTestId("url").textContent).toBe(url);
    expect(screen.getByTestId("url").dataset.navigationType).toBe("POP");
    expect(load).not.toHaveBeenCalled();
    page.unmount();
    page.queryClient.clear();
  });
});
