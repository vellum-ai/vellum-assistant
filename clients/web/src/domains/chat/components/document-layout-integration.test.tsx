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
import { Notice } from "@vellumai/design-library";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { create } from "zustand";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { publish } from "@/lib/event-bus";
import type * as Readiness from "@/hooks/use-is-org-ready";
import { liveViewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import type * as ErrorCapture from "@/lib/sentry/capture-error";

import { DocumentChatContent } from "./document-chat-content";
import type * as Editor from "./tiptap-document-editor";
import type * as Chat from "./chat-route-content";
import type * as Progress from "./progress-stack";
import type * as ChatInfo from "./chat-info-panel";
import type * as Surfaces from "../api/surfaces";
import { useOpenDocumentFromChat } from "../hooks/use-open-app-from-chat";
import { useComposerSubmit } from "../hooks/use-composer-submit";
import { useComposerStore } from "../composer-store";

const useReadiness = create<{ value: Readiness.OrgHeaderReadiness }>(() => ({
  value: "ready",
}));
const downloadDocumentPdf = mock(
  async (
    _assistantId: string,
    _surfaceId: string,
    _title: string | null | undefined,
  ) => {},
);
mock.module(
  "../api/surfaces",
  (): Partial<typeof Surfaces> => ({ downloadDocumentPdf }),
);

mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof Readiness> => ({
    useOrgHeaderReadiness: () => useReadiness((state) => state.value),
  }),
);
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof ErrorCapture> => ({
    captureError: mock(() => {}),
  }),
);
mock.module(
  "./progress-stack",
  (): Partial<typeof Progress> => ({ ProgressStack: () => null }),
);
mock.module(
  "./chat-info-panel",
  (): Partial<typeof ChatInfo> => ({
    ChatInfoPanel: ({ payload, onClose }) => {
      const openDocument = useOpenDocumentFromChat(
        payload.assistantId,
        onClose,
      );
      return (
        <>
          <button onClick={onClose}>Close chat info</button>
          <button onClick={() => void openDocument("surface-1")}>
            Reopen from chat info
          </button>
        </>
      );
    },
  }),
);
const comments = await import("../api/document-comments");
mock.module(
  "../api/document-comments",
  (): Partial<typeof comments> => ({
    ...comments,
    fetchComments: async () => [
      {
        id: "comment-1",
        surfaceId: "surface-1",
        conversationId: "conv-1",
        author: "user",
        content: "Please revise this paragraph",
        anchorStart: null,
        anchorEnd: null,
        anchorText: null,
        parentCommentId: null,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }),
);
mock.module(
  "./tiptap-document-editor",
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

// Keep the production layout, route controller, drawer and editor/save hook.
// Unrelated chat content, Chat Info and the Tiptap input boundary are stubbed.
mock.module(
  "./chat-route-content",
  (): Partial<typeof Chat> => ({
    ChatMainPanel: ({
      documentRoute,
      documentEditorRef,
      documentPreparation,
    }) => {
      useDocumentEditorSync();
      const isMobile = useIsMobile();
      const location = useLocation();
      const opened = useViewerStore.use.openedDocumentState();
      const openDocument = useOpenDocumentFromChat();
      const composer = useComposerSubmit({
        assistantId: "assistant-1",
        activeConversationId: "conv-1",
        inputRef: { current: null },
        sendMessage: send,
        scrollToLatest: () => {},
        isEditing: false,
        editingMessageId: null,
        cancelEditing: () => {},
        canUndoEdit: false,
        sendDisabled: false,
        typingDisabled: false,
        prepareSend: documentPreparation?.prepareSend,
      });
      return (
        <>
          <div data-testid="url">
            {location.pathname}
            {location.search}
          </div>
          <button onClick={() => void openDocument("surface-1")}>
            Open document
          </button>
          <button onClick={() => void openDocument("surface-2")}>
            Open another document
          </button>
          <button onClick={() => void composer.submitMessage()}>
            Send chat
          </button>
          <button
            onClick={async () => {
              if (
                !documentPreparation ||
                (await documentPreparation.prepareVoice())
              ) {
                startVoice();
              }
            }}
          >
            Start voice
          </button>
          <button onClick={documentRoute.viewConversation}>
            View conversation
          </button>
          {documentPreparation?.error && (
            <Notice tone="error" data-testid="preparation-error">
              {documentPreparation.error}
            </Notice>
          )}
          {isMobile && documentRoute.surfaceId && (
            <DocumentChatContent
              assistantId="assistant-1"
              surfaceId={documentRoute.surfaceId}
              document={opened}
              loading={documentRoute.isLoading}
              error={documentRoute.error}
              editorRef={documentEditorRef}
              onClose={documentRoute.closeDocument}
              onRetry={documentRoute.reloadDocument}
              onSubmitFeedback={() => {}}
            />
          )}
        </>
      );
    },
  }),
);
const { ChatContentLayout } = await import("./chat-content-layout");
const { DocumentViewerPage } = await import("../document-viewer-page");
const viewport = liveViewportAxesStub();
let pointerIsCoarse = false;

function resizeViewport(mobile: boolean) {
  viewport.set({ narrow: mobile, coarsePointer: pointerIsCoarse });
}
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
let sentDocument: DocumentContent | undefined;
const send = mock(async (_content: string) => {
  sentDocument = { ...saved };
});
const startVoice = mock(() => ({ ...saved }));
let pendingWrite: Promise<void> | undefined;
let finishWrite: () => void;
let failWrite: (error: Error) => void;
let linked: boolean;
let pendingConversationRead: Promise<void> | undefined;
const conversationLoad = mock(async () => {
  await pendingConversationRead;
  return {
    data: { conversation: { id: "conv-1" } },
    response: new Response(null, { status: linked ? 200 : 404 }),
  };
});
const load = mock(async () => ({ data: { ...saved } }));
const write = mock(
  async ({ body }: { body: { title: string; content: string } }) => {
    await pendingWrite;
    saved = { ...saved, ...body };
    return { data: { success: true } };
  },
);
const selection = useResolvedAssistantsStore.getState();
const conversation = useConversationStore.getState();
const viewer = useViewerStore.getState();
let queryClient: QueryClient;

beforeEach(() => {
  send.mockClear();
  sentDocument = undefined;
  startVoice.mockClear();
  useComposerStore.setState({
    input: "Revise this paragraph",
    attachments: [],
  });
  downloadDocumentPdf.mockClear();
  useReadiness.setState({ value: "ready" });
  saved = { ...original };
  linked = true;
  pendingConversationRead = undefined;
  conversationLoad.mockClear();
  load.mockClear();
  write.mockClear();
  pendingWrite = new Promise((resolve, reject) => {
    finishWrite = resolve;
    failWrite = reject;
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useConversationStore.setState({ activeConversationId: "conv-1" });
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
      return conversationLoad();
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
  spyOn(daemonClient, "post").mockImplementation(
    write as typeof daemonClient.post,
  );
});
afterEach(async () => {
  await act(async () => {
    finishWrite();
    cleanup();
  });
  queryClient.clear();
  viewport.restore();
  document.body.style.pointerEvents = "";
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
  useComposerStore.setState({ input: "", attachments: [] });
});

function renderLayout(mobile: boolean, urlBacked = true) {
  pointerIsCoarse = mobile;
  resizeViewport(mobile);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          `/assistant/conversations/conv-1${urlBacked ? "?document=surface-1" : ""}`,
        ]}
      >
        <Routes>
          <Route
            path="/assistant/conversations/:conversationId"
            element={<ChatContentLayout {...({} as Chat.ChatMainPanelProps)} />}
          />
          <Route
            path="/assistant/documents/:surfaceId"
            element={<DocumentViewerPage />}
          />
          <Route path="/assistant/library" element={<div>Library</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("document viewport handoff", () => {
  for (const urlBacked of [true, false]) {
    test.todo(
      `refreshes a mounted editor after a remote client save (URL-backed: ${urlBacked})`,
      async () => {
        renderLayout(false, urlBacked);
        if (!urlBacked) {
          fireEvent.click(
            screen.getByRole("button", { name: "Open document" }),
          );
        }
        const editor = await screen.findByRole("textbox", {
          name: "Document body",
        });
        await act(async () => {
          saved = { ...saved, content: "Remote client body" };
          publish("sse.event", {
            id: "event-remote-save",
            emittedAt: new Date().toISOString(),
            message: {
              type: "sync_changed",
              tags: ["documents:list"],
              originClientId: "client-other",
            },
          });
        });
        await waitFor(() =>
          expect((editor as HTMLTextAreaElement).value).toBe(
            "Remote client body",
          ),
        );
      },
    );
  }

  test.each([
    { mobile: true, remoteSave: false },
    { mobile: false, remoteSave: false },
    { mobile: true, remoteSave: true },
    { mobile: false, remoteSave: true },
  ])(
    "keeps document updates received during conversation resolution: %j",
    async ({ mobile, remoteSave }) => {
      let finishConversation!: () => void;
      pendingConversationRead = new Promise((resolve) => {
        finishConversation = resolve;
      });
      const page = renderLayout(mobile);
      await waitFor(() => expect(conversationLoad).toHaveBeenCalledTimes(1));
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        saved = { ...saved, content: "Latest assistant body" };
        publish("sse.event", {
          id: "event-update",
          emittedAt: new Date().toISOString(),
          message: remoteSave
            ? {
                type: "sync_changed",
                tags: ["documents:list"],
                originClientId: "client-other",
              }
            : {
                type: "document_editor_update",
                surfaceId: "surface-1",
                conversationId: "conv-1",
                markdown: "Latest assistant body",
                mode: "replace",
              },
        });
        finishConversation();
      });
      const editor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      expect((editor as HTMLTextAreaElement).value).toBe(
        "Latest assistant body",
      );
      expect(load).toHaveBeenCalledTimes(2);
      fireEvent.change(editor, {
        target: {
          value: `${(editor as HTMLTextAreaElement).value} plus local edit`,
        },
      });
      await act(async () => finishWrite());
      page.unmount();
      await waitFor(() =>
        expect(saved.content).toBe("Latest assistant body plus local edit"),
      );
    },
  );

  test.each([false, true])(
    "reopening the same desktop document retains its unsaved editor (URL-backed: %s)",
    async (urlBacked) => {
      renderLayout(false, urlBacked);
      if (!urlBacked) {
        fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      }
      const editor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      fireEvent.change(editor, {
        target: { value: "Unsaved first document body" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("textbox", { name: "Document body" })).toBe(
        editor,
      );
      expect((editor as HTMLTextAreaElement).value).toBe(
        "Unsaved first document body",
      );
      if (urlBacked) {
        expect(screen.getByTestId("url").textContent).toContain(
          "document=surface-1",
        );
      } else {
        expect(screen.getByTestId("url").textContent).toBe(
          "/assistant/conversations/conv-1",
        );
      }
    },
  );

  test.each(["success", "failure", "cancelled"])(
    "ordinary desktop Chat Info reopening waits for its detached save: %s",
    async (outcome) => {
      const page = renderLayout(false, false);
      fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        { target: { value: "Latest drawer edit" } },
      );
      act(() =>
        useViewerStore.getState().openChatInfo({
          assistantId: "assistant-1",
          conversationId: "conv-1",
        }),
      );
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Reopen from chat info",
        }),
      );
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(1);
      expect(
        Boolean(screen.queryByRole("textbox", { name: "Document body" })),
      ).toBe(false);
      if (outcome === "cancelled") {
        act(() => useViewerStore.getState().closeDocument());
        await act(async () => finishWrite());
        expect(load).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().openedDocumentState).toBeNull();
        return;
      }
      if (outcome === "failure") {
        await act(async () => failWrite(new Error("offline")));
        expect(load).toHaveBeenCalledTimes(1);
        expect(useViewerStore.getState().openedDocumentState).toBeNull();
        pendingWrite = undefined;
        fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      } else {
        await act(async () => finishWrite());
      }
      const editor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      expect((editor as HTMLTextAreaElement).value).toBe("Latest drawer edit");
      expect(load).toHaveBeenCalledTimes(2);
      fireEvent.change(editor, {
        target: { value: "Latest drawer edit plus more" },
      });
      page.unmount();
      await waitFor(() =>
        expect(saved.content).toBe("Latest drawer edit plus more"),
      );
    },
  );

  test("a transcript document replaces the URL-backed desktop document and preserves its pending save", async () => {
    renderLayout(false);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      {
        target: { value: "Latest first document body" },
      },
    );
    load.mockImplementationOnce(async () => ({
      data: {
        ...original,
        surfaceId: "surface-2",
        title: "Second document",
        content: "Second body",
      },
    }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open another document" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toBe(
        "/assistant/conversations/conv-1",
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Document body",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Second body"),
    );
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      source: "document",
      surfaceId: "surface-2",
    });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await act(async () => finishWrite());
    expect(saved.content).toBe("Latest first document body");
  });

  test.each(["unavailable", "resolving"] as const)(
    "desktop document readiness=%s exposes the error and close action",
    async (initialReadiness) => {
      useReadiness.setState({ value: initialReadiness });
      renderLayout(false);
      if (initialReadiness === "resolving") {
        await screen.findByRole("button", { name: "Close document" });
        expect(load).not.toHaveBeenCalled();
        act(() => useReadiness.setState({ value: "unavailable" }));
      }
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(useViewerStore.getState().mainView).toBe("document");
      expect(load).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close document" }));
      expect(screen.getByTestId("url").textContent).toBe(
        "/assistant/conversations/conv-1",
      );
      expect(useViewerStore.getState().mainView).toBe("chat");
      await waitFor(() =>
        expect(Boolean(screen.queryByRole("alert"))).toBe(false),
      );
    },
  );

  test("desktop readiness recovery retains the drawer and loads the document", async () => {
    useReadiness.setState({ value: "unavailable" });
    renderLayout(false);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => useReadiness.setState({ value: "ready" }));
    expect(
      await screen.findByRole("textbox", { name: "Document body" }),
    ).toBeTruthy();
    expect(useViewerStore.getState().mainView).toBe("document");
    expect(load).toHaveBeenCalledTimes(1);
    expect(Boolean(screen.queryByRole("alert"))).toBe(false);
  });

  test("replacing a desktop document flushes edits without closing the new panel", async () => {
    renderLayout(false);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      { target: { value: "Latest edited body" } },
    );
    act(() =>
      useViewerStore.getState().openChatInfo({
        assistantId: "assistant-1",
        conversationId: "conv-1",
      }),
    );
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const close = await screen.findByRole("button", {
      name: "Close chat info",
    });
    expect(screen.getByTestId("url").textContent).toBe(
      "/assistant/conversations/conv-1",
    );
    expect(useViewerStore.getState().mainView).toBe("chat-info");
    expect(
      Boolean(screen.queryByRole("textbox", { name: "Document body" })),
    ).toBe(false);
    await act(async () => finishWrite());
    expect(saved.content).toBe("Latest edited body");
    fireEvent.click(close);
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(screen.getByTestId("url").textContent).toBe(
      "/assistant/conversations/conv-1",
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      Boolean(screen.queryByRole("textbox", { name: "Document body" })),
    ).toBe(false);
  });

  test.each([
    { mobile: true, urlBacked: true, stage: "debouncing" },
    { mobile: true, urlBacked: true, stage: "in flight" },
    { mobile: false, urlBacked: true, stage: "debouncing" },
    { mobile: false, urlBacked: false, stage: "debouncing" },
    { mobile: false, urlBacked: false, stage: "in flight" },
  ])(
    "preserves edits when leaving mobile=$mobile, URL-backed=$urlBacked, save=$stage",
    async ({ mobile, urlBacked, stage }) => {
      const page = renderLayout(mobile, urlBacked);
      if (!urlBacked) {
        fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      }
      const oldEditor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      fireEvent.change(oldEditor, { target: { value: "Latest local body" } });
      if (stage === "in flight") {
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1), {
          timeout: 2000,
        });
      }
      const loads = load.mock.calls.length;
      act(() => resizeViewport(!mobile));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(
        Boolean(screen.queryByRole("textbox", { name: "Document body" })),
      ).toBe(false);
      expect(load).toHaveBeenCalledTimes(loads);
      await act(async () => finishWrite());
      const nextEditor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      expect((nextEditor as HTMLTextAreaElement).value).toBe(
        "Latest local body",
      );
      expect(load.mock.calls.length).toBeGreaterThan(loads);
      expect(
        screen.getAllByRole("textbox", { name: "Document body" }),
      ).toHaveLength(1);
      fireEvent.change(nextEditor, {
        target: {
          value: `${(nextEditor as HTMLTextAreaElement).value} with another edit`,
        },
      });
      page.unmount();
      await waitFor(() =>
        expect(saved.content).toBe("Latest local body with another edit"),
      );
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  test("closing the incoming desktop editor cancels the handoff read", async () => {
    renderLayout(true);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      { target: { value: "Latest local body" } },
    );
    act(() => resizeViewport(false));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    await act(async () => finishWrite());
    expect(screen.getByTestId("url").textContent).toBe(
      "/assistant/conversations/conv-1",
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(
      Boolean(screen.queryByRole("textbox", { name: "Document body" })),
    ).toBe(false);
  });

  test.each([
    { mobile: true, stage: "debouncing" },
    { mobile: true, stage: "in flight" },
    { mobile: false, stage: "debouncing" },
    { mobile: false, stage: "in flight" },
  ])(
    "retry retains edits after a failed handoff from mobile=$mobile, save=$stage",
    async ({ mobile, stage }) => {
      renderLayout(mobile);
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        { target: { value: "Unsaved local body" } },
      );
      if (stage === "in flight") {
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1), {
          timeout: 2000,
        });
      }
      act(() => resizeViewport(!mobile));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      await act(async () => failWrite(new Error("offline")));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(
        Boolean(screen.queryByRole("textbox", { name: "Document body" })),
      ).toBe(false);
      expect(load).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(load).toHaveBeenCalledTimes(1);
      pendingWrite = undefined;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const input = await screen.findByRole("textbox", {
        name: "Document body",
      });
      expect((input as HTMLTextAreaElement).value).toBe("Unsaved local body");
      expect(saved.content).toBe("Unsaved local body");
      expect(write).toHaveBeenCalledTimes(3);
    },
  );

  test("a desktop document with a deleted link reaches explicit mobile recovery", async () => {
    renderLayout(false, false);
    fireEvent.click(screen.getByRole("button", { name: "Open document" }));
    await screen.findByRole("textbox", { name: "Document body" });
    linked = false;
    act(() => resizeViewport(true));
    expect(
      await screen.findByRole("button", {
        name: "Start a linked conversation",
      }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Document body",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Original body");
    expect(write).not.toHaveBeenCalled();
  });
});

async function openFeedback() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Comments" }));
  return screen.findByRole("button", { name: /Submit feedback/i });
}

async function renameDocument(title: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByText("Rename"));
  const name = await screen.findByLabelText("Name");
  await user.clear(name);
  await user.type(name, title);
  await user.click(screen.getByRole("button", { name: "Save" }));
}

async function exportDocument() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByText("Export"));
}

describe("document session chat handoff", () => {
  test.each([
    { mobile: false, rename: false, action: "send" },
    { mobile: false, rename: true, action: "send" },
    { mobile: false, rename: false, action: "voice" },
    { mobile: false, rename: true, action: "voice" },
    { mobile: true, rename: false, action: "send" },
    { mobile: true, rename: false, action: "voice" },
  ])(
    "flushes the mounted editor before handoff: %j",
    async ({ mobile, rename, action }) => {
      renderLayout(mobile);
      const editor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      if (rename) {
        await renameDocument("Latest handoff title");
      } else {
        fireEvent.change(editor, { target: { value: "Latest handoff body" } });
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "send" ? "Send chat" : "Start voice",
        }),
      );
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(send).not.toHaveBeenCalled();
      expect(startVoice).not.toHaveBeenCalled();
      expect(useComposerStore.getState().input).toBe("Revise this paragraph");
      await act(async () => finishWrite());
      if (action === "send") {
        await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        expect(sentDocument).toMatchObject({
          title: rename ? "Latest handoff title" : "Notes",
          content: rename ? "Original body" : "Latest handoff body",
        });
      } else {
        await waitFor(() => expect(startVoice).toHaveBeenCalledTimes(1));
        expect(startVoice.mock.results[0]!.value).toMatchObject({
          title: rename ? "Latest handoff title" : "Notes",
          content: rename ? "Original body" : "Latest handoff body",
        });
      }
    },
  );

  test.each([
    { action: "send", outcome: "failed" },
    { action: "voice", outcome: "failed" },
    { action: "send", outcome: "closed" },
    { action: "voice", outcome: "closed" },
    { action: "send", outcome: "switched assistant" },
    { action: "voice", outcome: "switched assistant" },
  ])(
    "cancels desktop handoff without clearing the draft: %j",
    async ({ action, outcome }) => {
      renderLayout(false);
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        { target: { value: "Unsaved body" } },
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "send" ? "Send chat" : "Start voice",
        }),
      );
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      await act(async () => {
        if (outcome === "failed") {
          failWrite(new Error("offline"));
        } else {
          if (outcome === "closed") {
            useViewerStore.getState().closeDocument();
          } else {
            useResolvedAssistantsStore.setState({
              activeAssistantId: "assistant-2",
            });
          }
          finishWrite();
        }
      });
      if (outcome === "failed") {
        await screen.findByTestId("preparation-error");
      }
      expect(send).not.toHaveBeenCalled();
      expect(startVoice).not.toHaveBeenCalled();
      expect(useComposerStore.getState().input).toBe("Revise this paragraph");
    },
  );

  test("ordinary desktop drawers do not attach document preparation to chat", async () => {
    renderLayout(false, false);
    fireEvent.click(screen.getByRole("button", { name: "Open document" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      { target: { value: "Drawer edit" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send chat" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(write).not.toHaveBeenCalled();
  });

  test("a desktop transcript without a mounted editor can send normally", async () => {
    renderLayout(false);
    await screen.findByRole("textbox", { name: "Document body" });
    fireEvent.click(screen.getByRole("button", { name: "View conversation" }));
    await waitFor(() =>
      expect(
        Boolean(screen.queryByRole("textbox", { name: "Document body" })),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send chat" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

describe("document PDF export saves", () => {
  test.each([
    { mobile: true, rename: false, inFlight: false },
    { mobile: false, rename: false, inFlight: true },
    { mobile: true, rename: true, inFlight: false },
  ])(
    "export waits for edits: mobile=$mobile, rename=$rename, inFlight=$inFlight",
    async ({ mobile, rename, inFlight }) => {
      renderLayout(mobile);
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        { target: { value: "Latest export body" } },
      );
      if (rename) {
        await renameDocument("Latest export title");
      }
      if (inFlight) {
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1), {
          timeout: 2000,
        });
      }
      await exportDocument();
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(downloadDocumentPdf).not.toHaveBeenCalled();
      await act(async () => finishWrite());
      await waitFor(() =>
        expect(downloadDocumentPdf).toHaveBeenCalledWith(
          "assistant-1",
          "surface-1",
          rename ? "Latest export title" : "Notes",
        ),
      );
      expect(saved.content).toBe("Latest export body");
    },
  );

  test.each(["save failure", "close", "assistant switch"])(
    "export is cancelled on %s during the save",
    async (action) => {
      renderLayout(true);
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        { target: { value: "Latest export body" } },
      );
      await exportDocument();
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      if (action === "save failure") {
        await act(async () => failWrite(new Error("offline")));
      } else {
        if (action === "close") {
          fireEvent.click(
            screen.getByRole("button", { name: "Close document" }),
          );
        } else {
          act(() =>
            useResolvedAssistantsStore.setState({
              activeAssistantId: "assistant-2",
            }),
          );
        }
        await act(async () => finishWrite());
      }
      expect(downloadDocumentPdf).not.toHaveBeenCalled();
    },
  );
});

describe("desktop document feedback", () => {
  test.each([
    { urlBacked: true, rename: false, linkedConversation: "conv-1" },
    { urlBacked: true, rename: true, linkedConversation: "conv-1" },
    { urlBacked: false, rename: false, linkedConversation: "conv-1" },
    { urlBacked: false, rename: true, linkedConversation: "conv-1" },
    { urlBacked: false, rename: false, linkedConversation: "conv-linked" },
  ])(
    "flushes before feedback: URL-backed=$urlBacked, rename=$rename, linked=$linkedConversation",
    async ({ urlBacked, rename, linkedConversation }) => {
      saved.conversationId = linkedConversation;
      renderLayout(false, urlBacked);
      if (!urlBacked) {
        fireEvent.click(screen.getByRole("button", { name: "Open document" }));
      }
      const editor = await screen.findByRole("textbox", {
        name: "Document body",
      });
      fireEvent.change(editor, { target: { value: "Latest local body" } });
      if (rename) {
        await renameDocument("Latest title");
      }
      const feedback = await openFeedback();
      const previousUrl = screen.getByTestId("url").textContent;
      fireEvent.click(feedback);
      fireEvent.click(feedback);
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url").textContent).toBe(previousUrl);
      expect((editor as HTMLTextAreaElement).disabled).toBe(true);
      await act(async () => finishWrite());
      await waitFor(() =>
        expect(screen.getByTestId("url").textContent).toContain("prompt="),
      );
      const destination = new URL(
        screen.getByTestId("url").textContent!,
        "https://example.com",
      );
      expect(destination.pathname).toBe(
        `/assistant/conversations/${linkedConversation}`,
      );
      expect(destination.searchParams.get("prompt")).toContain(
        rename ? "Latest title" : "Notes",
      );
      expect(saved.content).toBe("Latest local body");
      expect(saved.title).toBe(rename ? "Latest title" : "Notes");
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  test("failed feedback preparation keeps the editable draft and can retry", async () => {
    renderLayout(false);
    const editor = await screen.findByRole("textbox", {
      name: "Document body",
    });
    fireEvent.change(editor, { target: { value: "Keep local body" } });
    fireEvent.click(await openFeedback());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await act(async () => failWrite(new Error("offline")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Document body" })).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe("Keep local body");
    expect((editor as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByTestId("url").textContent).not.toContain("prompt=");
    pendingWrite = Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /Submit feedback/i }));
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toContain("prompt="),
    );
    expect(saved.content).toBe("Keep local body");
    expect(write).toHaveBeenCalledTimes(2);
  });

  test.each(["close", "assistant switch", "conversation switch"])(
    "%s cancels feedback while the save is pending",
    async (action) => {
      renderLayout(false);
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Document body" }),
        {
          target: { value: "Latest local body" },
        },
      );
      fireEvent.click(await openFeedback());
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      if (action === "close") {
        fireEvent.click(screen.getByRole("button", { name: "Close document" }));
      } else if (action === "assistant switch") {
        act(() =>
          useResolvedAssistantsStore.setState({
            activeAssistantId: "assistant-2",
          }),
        );
      } else {
        act(() =>
          useConversationStore.setState({ activeConversationId: "conv-2" }),
        );
      }
      await act(async () => finishWrite());
      expect(screen.getByTestId("url").textContent).not.toContain("prompt=");
      expect(saved.content).toBe("Latest local body");
    },
  );
});
