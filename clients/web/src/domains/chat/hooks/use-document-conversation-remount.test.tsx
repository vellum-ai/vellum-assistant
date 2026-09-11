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
import { useRef } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type * as OrgReadiness from "@/hooks/use-is-org-ready";
import type * as ErrorCapture from "@/lib/sentry/capture-error";

import type * as Editor from "../components/tiptap-document-editor";
import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";

const original: DocumentContent = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Notes",
  content: "Original body",
  wordCount: 2,
  createdAt: 1,
  updatedAt: 1,
};
let saved: DocumentContent;
let pendingWrite: Promise<void> | undefined;
const load = mock(async () => ({ data: { ...saved } }));
const write = mock(
  async ({ body }: { body: { content: string; title: string } }) => {
    await pendingWrite;
    saved = { ...saved, ...body };
    return { data: { success: true } };
  },
);
mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof OrgReadiness> => ({
    useOrgHeaderReadiness: () => "ready",
  }),
);
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof ErrorCapture> => ({ captureError: mock(() => {}) }),
);
const comments = await import("../api/document-comments");
mock.module(
  "../api/document-comments",
  (): Partial<typeof comments> => ({
    ...comments,
    fetchComments: async () => [],
  }),
);
mock.module(
  "../components/tiptap-document-editor",
  (): Partial<typeof Editor> => ({
    TiptapDocumentEditor: ({ content, editable, onContentChange }) => (
      <textarea
        aria-label="Document body"
        defaultValue={content}
        disabled={!editable}
        onChange={(event) => onContentChange?.(event.target.value)}
      />
    ),
  }),
);
const { useDocumentConversationRoute } =
  await import("./use-document-conversation-route");
const { DocumentChatContent } =
  await import("../components/document-chat-content");

function DocumentSession() {
  const route = useDocumentConversationRoute();
  const document = useViewerStore.use.openedDocumentState();
  const editorRef = useRef<DocumentViewerContainerHandle>(null);
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/assistant/library")}>
        Leave session
      </button>
      <DocumentChatContent
        assistantId="assistant-1"
        surfaceId={route.surfaceId}
        document={document}
        loading={route.isLoading}
        error={route.error}
        editorRef={editorRef}
        onClose={route.closeDocument}
        onRetry={route.reloadDocument}
        onSubmitFeedback={() => {}}
      />
    </>
  );
}

function Library() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back</button>;
}

const selection = useResolvedAssistantsStore.getState();
const viewer = useViewerStore.getState();
let queryClient: QueryClient;
beforeEach(() => {
  saved = { ...original };
  pendingWrite = undefined;
  load.mockClear();
  write.mockClear();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useViewerStore.setState({
    mainView: "chat",
    openedDocumentState: null,
    activeDocumentTarget: null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
  spyOn(daemonClient, "post").mockImplementation(
    write as typeof daemonClient.post,
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
});

function renderSession() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={["/assistant/conversations/conv-1?document=surface-1"]}
      >
        <Routes>
          <Route
            path="/assistant/conversations/:conversationId"
            element={<DocumentSession />}
          />
          <Route path="/assistant/library" element={<Library />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("document editor history remount", () => {
  test("a failed pending save exposes retry instead of opening the retained body", async () => {
    let failWrite!: (error: Error) => void;
    pendingWrite = new Promise((_resolve, reject) => {
      failWrite = reject;
    });
    renderSession();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      {
        target: { value: "Unsaved edit" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => failWrite(new Error("offline")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Document body" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close document" })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    pendingWrite = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const input = await screen.findByRole("textbox", { name: "Document body" });
    expect((input as HTMLTextAreaElement).value).toBe(original.content);
    expect(load).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("leaving while waiting for a prior save cannot load or reopen the document", async () => {
    let finishWrite!: () => void;
    pendingWrite = new Promise((resolve) => {
      finishWrite = resolve;
    });
    renderSession();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      {
        target: { value: "Latest saved body" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
    await act(async () => finishWrite());
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test.each(["completed", "in flight"])(
    "returning after a %s save opens the latest body and preserves it on the next edit",
    async (outcome) => {
      let finishWrite!: () => void;
      pendingWrite = new Promise((resolve) => {
        finishWrite = resolve;
      });
      const page = renderSession();
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        {
          target: { value: "Latest saved body" },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      if (outcome === "completed") {
        await act(async () => finishWrite());
      }
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      if (outcome === "in flight") {
        await act(async () => {});
        expect(
          screen.queryByRole("textbox", { name: "Document body" }),
        ).toBeNull();
        expect(load).toHaveBeenCalledTimes(1);
        await act(async () => finishWrite());
      }
      const input = await screen.findByRole("textbox", {
        name: "Document body",
      });
      expect((input as HTMLTextAreaElement).value).toBe("Latest saved body");
      expect(load).toHaveBeenCalledTimes(2);
      fireEvent.change(input, {
        target: {
          value: `${(input as HTMLTextAreaElement).value} with another edit`,
        },
      });
      page.unmount();
      await waitFor(() =>
        expect(saved.content).toBe("Latest saved body with another edit"),
      );
      expect(write).toHaveBeenCalledTimes(2);
    },
  );
});
