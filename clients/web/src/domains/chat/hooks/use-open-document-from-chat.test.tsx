import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import type { PropsWithChildren } from "react";

import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type * as Mobile from "@/hooks/use-is-mobile";
import { trackDocumentSave } from "../api/document-save";

const documentData = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-linked",
  title: "Notes",
  content: "Body",
  wordCount: 1,
  createdAt: 1,
  updatedAt: 1,
};
const load = mock(async () => ({ data: documentData }));
let found = true;
const createConversation = mock(async () => ({}));
mock.module(
  "@/hooks/use-is-mobile",
  (): Partial<typeof Mobile> => ({
    useIsMobile: () => true,
    MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  }),
);
const { useOpenDocumentFromChat } = await import("./use-open-app-from-chat");

let originPath = "/assistant/conversations/conv-origin";
function Wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter initialEntries={[originPath]}>{children}</MemoryRouter>;
}

let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let conversation: ReturnType<typeof useConversationStore.getState>;
let viewer: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => {
  originPath = "/assistant/conversations/conv-origin";
  selection = useResolvedAssistantsStore.getState();
  conversation = useConversationStore.getState();
  viewer = useViewerStore.getState();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useConversationStore.setState({ activeConversationId: "conv-origin" });
  useViewerStore.setState({ mainView: "chat", openedDocumentState: null });
  found = true;
  createConversation.mockClear();
  load.mockReset();
  load.mockImplementation(async () => ({ data: documentData }));
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
    path: { id: string };
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      return load();
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return {
        data: { conversation: { id: options.path.id } },
        response: new Response(null, { status: found ? 200 : 404 }),
      };
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
  spyOn(daemonClient, "post").mockImplementation(
    createConversation as typeof daemonClient.post,
  );
});
afterEach(() => {
  cleanup();
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
});

describe("mobile chat document entry", () => {
  test.each(["", "/"])(
    "selects the linked conversation and preserves the origin suffix '%s'",
    async (suffix) => {
      originPath += suffix;
      const { result } = renderHook(
        () => ({ open: useOpenDocumentFromChat(), location: useLocation() }),
        { wrapper: Wrapper },
      );
      await act(() => result.current.open("surface-1"));
      expect(result.current.location.pathname).toBe(
        "/assistant/conversations/conv-linked",
      );
      expect(
        new URLSearchParams(result.current.location.search).get(
          "documentReturn",
        ),
      ).toBe(originPath);
      expect(useConversationStore.getState().activeConversationId).toBe(
        "conv-linked",
      );
      expect(createConversation).not.toHaveBeenCalled();
    },
  );

  test("a missing link goes to explicit recovery without creating a conversation", async () => {
    found = false;
    const { result } = renderHook(
      () => ({ open: useOpenDocumentFromChat(), location: useLocation() }),
      { wrapper: Wrapper },
    );
    await act(() => result.current.open("surface-1"));
    expect(result.current.location.pathname).toBe(
      "/assistant/documents/surface-1",
    );
    expect(createConversation).not.toHaveBeenCalled();
  });

  test("an assistant switch cancels a pending document entry", async () => {
    let resolveLoad!: (value: { data: typeof documentData }) => void;
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const { result } = renderHook(
      () => ({ open: useOpenDocumentFromChat(), location: useLocation() }),
      { wrapper: Wrapper },
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.open("surface-1");
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() =>
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" }),
    );
    await act(async () => {
      resolveLoad({ data: documentData });
      await pending;
    });
    expect(result.current.location.pathname).toBe(
      "/assistant/conversations/conv-origin",
    );
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });

  test.each([false, true])(
    "fresh entry waits for a detached save (cancelled: %s)",
    async (cancelled) => {
      let finishWrite!: () => void;
      trackDocumentSave(
        { assistantId: "assistant-1", surfaceId: "surface-1" },
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
      );
      const { result } = renderHook(
        () => ({ open: useOpenDocumentFromChat(), location: useLocation() }),
        { wrapper: Wrapper },
      );
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.open("surface-1");
      });
      await act(async () => {});
      try {
        expect(load).not.toHaveBeenCalled();
        if (cancelled) {
          act(() =>
            useResolvedAssistantsStore.setState({
              activeAssistantId: "assistant-2",
            }),
          );
        }
      } finally {
        await act(async () => {
          finishWrite();
          await pending;
        });
      }
      expect(load).toHaveBeenCalledTimes(cancelled ? 0 : 1);
      expect(result.current.location.pathname).toBe(
        cancelled ? originPath : "/assistant/conversations/conv-linked",
      );
    },
  );
});
