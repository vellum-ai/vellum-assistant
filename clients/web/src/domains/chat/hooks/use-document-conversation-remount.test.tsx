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
import { useEffect, useRef } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type * as OrgReadiness from "@/hooks/use-is-org-ready";
import type * as ErrorCapture from "@/lib/sentry/capture-error";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

import type * as Editor from "../components/tiptap-document-editor";
import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";
import { useOpenDocumentFromChat } from "./use-open-app-from-chat";

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
let finishPendingWrite: (() => void) | undefined;

function holdWrite() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  pendingWrite = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  finishPendingWrite = resolve;
  return { resolve, reject };
}
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
    TiptapDocumentEditor: ({ content, editable, onContentChange }) => {
      const input = useRef<HTMLTextAreaElement>(null);
      useEffect(() => {
        if (input.current) {
          input.current.value = content;
        }
      }, [content]);
      return (
        <textarea
          ref={input}
          aria-label="Document body"
          defaultValue={content}
          disabled={!editable}
          onChange={(event) => onContentChange?.(event.target.value)}
        />
      );
    },
  }),
);
const { useDocumentConversationRoute } =
  await import("./use-document-conversation-route");
const { DocumentChatContent } =
  await import("../components/document-chat-content");
const { DocumentViewerPage } = await import("../document-viewer-page");
const viewport = viewportAxesStub();
let entryMode: "conversation" | "recovery" | "standalone";

function DocumentSession() {
  const route = useDocumentConversationRoute();
  const openDocument = useOpenDocumentFromChat(
    "assistant-1",
    useViewerStore.getState().closeChatInfo,
  );
  const document = useViewerStore.use.openedDocumentState();
  const editorRef = useRef<DocumentViewerContainerHandle>(null);
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/assistant/library")}>
        Leave session
      </button>
      <button onClick={route.viewConversation}>View conversation</button>
      <button
        onClick={() => {
          useViewerStore
            .getState()
            .openChatInfo({
              assistantId: "assistant-1",
              conversationId: "conv-1",
            });
          void openDocument("surface-1");
        }}
      >
        Open from Chat Info
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
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate("/assistant/documents/surface-1")}>
        Open document
      </button>
    </>
  );
}

const selection = useResolvedAssistantsStore.getState();
const viewer = useViewerStore.getState();
let queryClient: QueryClient;
beforeEach(() => {
  saved = { ...original };
  pendingWrite = undefined;
  finishPendingWrite = undefined;
  entryMode = "conversation";
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
        response: new Response(null, {
          status: entryMode === "recovery" ? 404 : 200,
        }),
      };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
  spyOn(daemonClient, "post").mockImplementation(
    write as typeof daemonClient.post,
  );
});
afterEach(async () => {
  await act(async () => {
    finishPendingWrite?.();
    cleanup();
  });
  viewport.restore();
  queryClient.clear();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useViewerStore.setState(viewer, true);
});

function renderSession(mode: typeof entryMode = "conversation") {
  entryMode = mode;
  viewport.set({
    narrow: mode !== "standalone",
    coarsePointer: mode !== "standalone",
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          mode === "conversation"
            ? "/assistant/conversations/conv-1?document=surface-1"
            : "/assistant/documents/surface-1",
        ]}
      >
        <Routes>
          <Route
            path="/assistant/conversations/:conversationId"
            element={<DocumentSession />}
          />
          <Route path="/assistant/library" element={<Library />} />
          <Route
            path="/assistant/documents/:surfaceId"
            element={<DocumentViewerPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("document editor history remount", () => {
  test.each(["debouncing", "in flight"])(
    "Chat Info reopens the same mounted editor with a %s save without loading stale content",
    async (stage) => {
      const { resolve: finishWrite } = holdWrite();
      const page = renderSession();
      const input = await screen.findByRole("textbox", {
        name: "Document body",
      });
      fireEvent.change(input, { target: { value: "Latest local body" } });
      if (stage === "in flight") {
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1), {
          timeout: 2000,
        });
      }
      fireEvent.click(
        screen.getByRole("button", { name: "View conversation" }),
      );
      const snapshot = useViewerStore.getState().openedDocumentState;
      fireEvent.click(
        screen.getByRole("button", { name: "Open from Chat Info" }),
      );
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(1);
      expect(useViewerStore.getState().openedDocumentState).toBe(snapshot);
      expect(useViewerStore.getState().mainView).toBe("document");
      expect(useViewerStore.getState().activeChatInfo).toBeNull();
      expect(screen.getByRole("textbox", { name: "Document body" })).toBe(
        input,
      );
      await act(async () => finishWrite());
      await waitFor(() => expect(saved.content).toBe("Latest local body"), {
        timeout: 2000,
      });
      expect((input as HTMLTextAreaElement).value).toBe("Latest local body");
      fireEvent.change(input, {
        target: {
          value: `${(input as HTMLTextAreaElement).value} with another edit`,
        },
      });
      page.unmount();
      await waitFor(() =>
        expect(saved.content).toBe("Latest local body with another edit"),
      );
    },
  );

  test.each(["recovery", "standalone"] as const)(
    "%s close and reopen waits for the detached save before editing again",
    async (mode) => {
      const { resolve: finishWrite } = holdWrite();
      const page = renderSession(mode);
      const first = await screen.findByRole("textbox", {
        name: "Document body",
      });
      if (mode === "recovery") {
        expect(
          screen.getByRole("button", { name: "Start a linked conversation" }),
        ).toBeTruthy();
      }
      fireEvent.change(first, { target: { value: "Latest saved body" } });
      fireEvent.click(screen.getByRole("button", { name: "Close document" }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      await act(async () => {});
      expect(
        screen.queryByRole("textbox", { name: "Document body" }),
      ).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => finishWrite());
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

  test("a failed pending save exposes retry instead of opening the retained body", async () => {
    const { reject: failWrite } = holdWrite();
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
    const { resolve: finishWrite } = holdWrite();
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
      const { resolve: finishWrite } = holdWrite();
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
