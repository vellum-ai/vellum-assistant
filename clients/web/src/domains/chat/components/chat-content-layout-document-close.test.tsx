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
  useNavigationType,
} from "react-router";

import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

import { useDocumentConversationRoute } from "../hooks/use-document-conversation-route";
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
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => "ready",
}));
mock.module("./chat-route-content", () => ({
  ChatMainPanel: () => {
    useDocumentConversationRoute();
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

function renderLayout(url: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/assistant/conversations/:conversationId"
            element={<ChatContentLayout {...({} as ChatMainPanelProps)} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...page, queryClient };
}

beforeEach(() => {
  viewport.set({ narrow: false, coarsePointer: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useConversationStore.setState({ activeConversationId: "conv-1" });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  load.mockClear();
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
  test.each(["button", "Escape"])(
    "%s clears document URL intent and stays closed on reload",
    async (dismissal) => {
      const page = renderLayout(
        "/assistant/conversations/conv-1?document=surface-1&documentReturn=%2Fassistant%2Flibrary&documentView=document&keep=1#message-1",
      );
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
