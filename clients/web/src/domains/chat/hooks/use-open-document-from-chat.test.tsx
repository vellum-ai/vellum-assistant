import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import type { PropsWithChildren } from "react";

import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

const sdk = await import("@/generated/daemon/sdk.gen");
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
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdk,
  documentsByIdGet: load,
  conversationsByIdGet: async ({ path }: { path: { id: string } }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: found ? 200 : 404 }),
  }),
  conversationsPost: createConversation,
}));
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => true,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));
const { useOpenDocumentFromChat } = await import("./use-open-app-from-chat");

function Wrapper({ children }: PropsWithChildren) {
  return (
    <MemoryRouter initialEntries={["/assistant/conversations/conv-origin"]}>
      {children}
    </MemoryRouter>
  );
}

let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let conversation: ReturnType<typeof useConversationStore.getState>;
let viewer: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState(selection, true);
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
});

describe("mobile chat document entry", () => {
  test("selects the document's linked conversation and preserves the originating route", async () => {
    const { result } = renderHook(
      () => ({ open: useOpenDocumentFromChat(), location: useLocation() }),
      { wrapper: Wrapper },
    );
    await act(() => result.current.open("surface-1"));
    expect(result.current.location.pathname).toBe(
      "/assistant/conversations/conv-linked",
    );
    expect(
      new URLSearchParams(result.current.location.search).get("documentReturn"),
    ).toBe("/assistant/conversations/conv-origin");
    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-linked",
    );
    expect(createConversation).not.toHaveBeenCalled();
  });

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
});
