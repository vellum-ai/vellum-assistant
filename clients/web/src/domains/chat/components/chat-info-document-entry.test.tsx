import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type * as ElementSize from "@/hooks/use-element-size";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";

import {
  CHAT_INFO_BODY_WIDTH_PX,
  clearTranscriptMessages,
  holdOrgHeaderUnresolved,
  installChatInfoDomStubs,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  makeElementSizeMock,
  seedChatInfoConversation,
  seedTranscriptMessages,
} from "./chat-info.test-helper";

const restoreDomStubs = installChatInfoDomStubs();
const viewport = viewportAxesStub();
mock.module(
  "@/hooks/use-element-size",
  (): Partial<typeof ElementSize> =>
    makeElementSizeMock(() => CHAT_INFO_BODY_WIDTH_PX),
);
const { ChatInfoPanel } = await import("./chat-info-panel");

const DOCUMENT: DocumentContent = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Notes",
  content: "Document body",
  wordCount: 2,
  createdAt: 1,
  updatedAt: 1,
};

function PanelHost() {
  const location = useLocation();
  const mainView = useViewerStore.use.mainView();
  const activeChatInfo = useViewerStore.use.activeChatInfo();
  return (
    <>
      <div data-testid="url">
        {location.pathname}
        {location.search}
      </div>
      {mainView === "chat-info" && activeChatInfo && (
        <ChatInfoPanel
          payload={activeChatInfo}
          onClose={useViewerStore.getState().closeChatInfo}
          onSelectCategory={useViewerStore.getState().setChatInfoCategory}
        />
      )}
    </>
  );
}

function renderPanel() {
  const client = makeChatInfoQueryClient();
  seedChatInfoConversation(client, {
    assistantId: "assistant-1",
    conversationId: "conv-1",
    documents: [makeDocumentSummary(DOCUMENT)],
  });
  seedTranscriptMessages("assistant-1", "conv-1", []);
  useViewerStore.getState().openChatInfo({
    assistantId: "assistant-1",
    conversationId: "conv-1",
  });
  return render(
    <MemoryRouter initialEntries={["/assistant/conversations/conv-1"]}>
      <QueryClientProvider client={client}>
        <PanelHost />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

let finishLoad: (value: DocumentContent) => void;
let failLoad: (error: Error) => void;
let documentLoad: Promise<DocumentContent>;
let conversationExists: boolean;
let releaseOrgHeader: () => void;
let viewer: ReturnType<typeof useViewerStore.getState>;
let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let conversation: ReturnType<typeof useConversationStore.getState>;

beforeEach(() => {
  viewer = useViewerStore.getState();
  selection = useResolvedAssistantsStore.getState();
  conversation = useConversationStore.getState();
  releaseOrgHeader = holdOrgHeaderUnresolved();
  viewport.set({ narrow: true, coarsePointer: true });
  useViewerStore.setState({
    mainView: "chat",
    activeChatInfo: null,
    openedDocumentState: null,
  });
  useConversationStore.setState({ activeConversationId: "conv-1" });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  conversationExists = true;
  documentLoad = new Promise((resolve, reject) => {
    finishLoad = resolve;
    failLoad = reject;
  });
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      return {
        data: await documentLoad,
        response: new Response(null, { status: 200 }),
      };
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return {
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, {
          status: conversationExists ? 200 : 404,
        }),
      };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
});

afterEach(() => {
  cleanup();
  mock.restore();
  viewport.restore();
  releaseOrgHeader();
  clearTranscriptMessages();
  useViewerStore.setState(viewer, true);
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
});
afterAll(restoreDomStubs);

describe("mobile Chat Info document entry", () => {
  test.each([true, false])(
    "keeps the panel mounted until document entry is ready (linked: %s)",
    async (linked) => {
      conversationExists = linked;
      renderPanel();
      fireEvent.click(screen.getByLabelText("Open Notes"));
      expect(screen.getByLabelText("Close chat info")).toBeTruthy();
      await act(async () => finishLoad(DOCUMENT));
      await waitFor(() =>
        expect(screen.queryByLabelText("Close chat info")).toBeNull(),
      );
      if (linked) {
        expect(screen.getByTestId("url").textContent).toContain(
          "document=surface-1",
        );
        expect(useViewerStore.getState().openedDocumentState).toMatchObject({
          surfaceId: "surface-1",
        });
      } else {
        expect(screen.getByTestId("url").textContent).toContain(
          "/assistant/documents/surface-1",
        );
      }
      expect(useViewerStore.getState().activeChatInfo).toBeNull();
    },
  );

  test.each(["close", "assistant switch"])(
    "does not navigate if the user cancels via %s",
    async (reason) => {
      renderPanel();
      fireEvent.click(screen.getByLabelText("Open Notes"));
      act(() => {
        if (reason === "close") {
          fireEvent.click(screen.getByLabelText("Close chat info"));
        } else {
          useResolvedAssistantsStore.setState({
            activeAssistantId: "assistant-2",
          });
        }
      });
      await act(async () => finishLoad(DOCUMENT));
      expect(screen.getByTestId("url").textContent).toBe(
        "/assistant/conversations/conv-1",
      );
      expect(useViewerStore.getState().openedDocumentState).toBeNull();
    },
  );

  test("a failed load keeps the panel open for retry", async () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Open Notes"));
    await act(async () => failLoad(new Error("offline")));
    expect(screen.getByLabelText("Close chat info")).toBeTruthy();
    documentLoad = Promise.resolve(DOCUMENT);
    fireEvent.click(screen.getByLabelText("Open Notes"));
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toContain(
        "document=surface-1",
      ),
    );
  });
});
