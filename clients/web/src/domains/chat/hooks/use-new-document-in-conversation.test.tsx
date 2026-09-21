import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { PropsWithChildren } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import type * as Mobile from "@/hooks/use-is-mobile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

const created = {
  success: true,
  surfaceId: "doc-new",
  conversationId: "conv-1",
  title: "Untitled Document",
  content: "",
  wordCount: 0,
  createdAt: 1,
  updatedAt: 1,
};
const toastError = mock(() => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastError, success: () => {} },
}));
mock.module(
  "@/hooks/use-is-mobile",
  (): Partial<typeof Mobile> => ({
    useIsMobile: () => false,
    MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  }),
);
const { useNewDocumentInConversation } =
  await import("./use-new-document-in-conversation");

let post: ReturnType<typeof spyOn>;
let queryClient: QueryClient;
let viewer: ReturnType<typeof useViewerStore.getState>;
let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;

function Wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/conversations/conv-1"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient();
  viewer = useViewerStore.getState();
  selection = useResolvedAssistantsStore.getState();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useViewerStore.setState({ mainView: "chat", openedDocumentState: null });
  toastError.mockClear();
  post = spyOn(daemonClient, "post").mockImplementation((async () => ({
    data: created,
  })) as unknown as typeof daemonClient.post);
  spyOn(daemonClient, "get").mockImplementation((async () => ({
    data: created,
  })) as unknown as typeof daemonClient.get);
});

afterEach(() => {
  cleanup();
  mock.restore();
  useViewerStore.setState(viewer, true);
  useResolvedAssistantsStore.setState(selection, true);
});

describe("useNewDocumentInConversation", () => {
  test("creates a document in the conversation and opens it in the viewer", async () => {
    const { result } = renderHook(
      () => useNewDocumentInConversation("assistant-1"),
      { wrapper: Wrapper },
    );

    await act(() => result.current("conv-1"));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({
      url: "/v1/assistants/{assistant_id}/documents/create",
      path: { assistant_id: "assistant-1" },
      body: { conversationId: "conv-1" },
    });
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      surfaceId: "doc-new",
      conversationId: "conv-1",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  test("a second pick while the first create is in flight is dropped", async () => {
    let finish!: () => void;
    post.mockImplementation(
      (() =>
        new Promise((resolve) => {
          finish = () => resolve({ data: created });
        })) as unknown as typeof daemonClient.post,
    );
    const { result } = renderHook(
      () => useNewDocumentInConversation("assistant-1"),
      { wrapper: Wrapper },
    );

    let first!: Promise<void>;
    await act(async () => {
      first = result.current("conv-1");
      await result.current("conv-1");
    });
    await act(async () => {
      finish();
      await first;
    });

    expect(post).toHaveBeenCalledTimes(1);
  });

  test("a failed create tells the user and opens nothing", async () => {
    post.mockImplementation((async () => {
      throw new Error("boom");
    }) as unknown as typeof daemonClient.post);
    const { result } = renderHook(
      () => useNewDocumentInConversation("assistant-1"),
      { wrapper: Wrapper },
    );

    await act(() => result.current("conv-1"));

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useViewerStore.getState().openedDocumentState).toBeNull();
  });
});
