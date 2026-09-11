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
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type * as Readiness from "@/hooks/use-is-org-ready";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import type * as ErrorCapture from "@/lib/sentry/capture-error";

import { DocumentChatContent } from "./document-chat-content";
import type * as Editor from "./tiptap-document-editor";
import type * as Chat from "./chat-route-content";
import type * as Progress from "./progress-stack";
import type { DocumentViewerContainerHandle } from "./document-viewer-container";
import { useOpenDocumentFromChat } from "../hooks/use-open-app-from-chat";

mock.module(
  "@/hooks/use-is-org-ready",
  (): Partial<typeof Readiness> => ({
    useOrgHeaderReadiness: () => "ready",
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
const comments = await import("../api/document-comments");
mock.module(
  "../api/document-comments",
  (): Partial<typeof comments> => ({
    ...comments,
    fetchComments: async () => [],
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
// Only the unrelated chat content and Tiptap input boundary are stubbed.
mock.module(
  "./chat-route-content",
  (): Partial<typeof Chat> => ({
    ChatMainPanel: ({ documentRoute }) => {
      const isMobile = useIsMobile();
      const location = useLocation();
      const opened = useViewerStore.use.openedDocumentState();
      const editorRef = useRef<DocumentViewerContainerHandle>(null);
      const openDocument = useOpenDocumentFromChat();
      return (
        <>
          <div data-testid="url">
            {location.pathname}
            {location.search}
          </div>
          <button onClick={() => void openDocument("surface-1")}>
            Open document
          </button>
          {isMobile && documentRoute.surfaceId && (
            <DocumentChatContent
              assistantId="assistant-1"
              surfaceId={documentRoute.surfaceId}
              document={opened}
              loading={documentRoute.isLoading}
              error={documentRoute.error}
              editorRef={editorRef}
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
const viewport = viewportAxesStub();
const mediaTargets = new Map<string, EventTarget>();
let pointerIsCoarse = false;

function resizeViewport(mobile: boolean) {
  viewport.set({ narrow: mobile, coarsePointer: pointerIsCoarse });
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => {
    let target = mediaTargets.get(query);
    if (!target) {
      target = new EventTarget();
      mediaTargets.set(query, target);
    }
    return Object.assign(matchMedia(query), {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    });
  };
  for (const [query, target] of mediaTargets) {
    target.dispatchEvent(
      Object.assign(new Event("change"), {
        matches: matchMedia(query).matches,
        media: query,
      }),
    );
  }
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
let pendingWrite: Promise<void> | undefined;
let finishWrite: () => void;
let failWrite: (error: Error) => void;
let linked: boolean;
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
  saved = { ...original };
  linked = true;
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
      return {
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: linked ? 200 : 404 }),
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
    finishWrite();
    cleanup();
  });
  queryClient.clear();
  viewport.restore();
  mediaTargets.clear();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
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

  test("a failed handoff save exposes an error instead of editing the stale snapshot", async () => {
    renderLayout(true);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Document body" }),
      { target: { value: "Unsaved local body" } },
    );
    act(() => resizeViewport(false));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await act(async () => failWrite(new Error("offline")));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      Boolean(screen.queryByRole("textbox", { name: "Document body" })),
    ).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

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
