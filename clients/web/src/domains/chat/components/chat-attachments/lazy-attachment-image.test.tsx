import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const fetchAttachmentContentBlob = mock(
  async (
    _assistantId: string,
    _attachmentId: string,
    _options?: {
      representation?: "original" | "display";
      signal?: AbortSignal;
    },
  ): Promise<Blob | null> => new Blob(["preview"]),
);

mock.module(
  "@/domains/chat/components/chat-attachments/download-attachment",
  () => ({
    fetchAttachmentContentBlob,
    downloadAttachment: async () => undefined,
  }),
);

const { LazyAttachmentImage } = await import(
  "@/domains/chat/components/chat-attachments/lazy-attachment-image"
);
const { BubbleAttachments } = await import(
  "@/domains/chat/components/chat-attachments/bubble-attachments"
);

let intersectionCallback: IntersectionObserverCallback | null = null;
let intersectionRoot: Element | Document | null = null;
let intersectionRootMargin = "";
const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
const createObjectURL = mock(() => "blob:display-preview");
const revokeObjectURL = mock((_url: string) => undefined);

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    intersectionCallback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    intersectionRoot = this.root;
    intersectionRootMargin = this.rootMargin;
  }

  disconnect(): void {}
  observe(_target: Element): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(_target: Element): void {}
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <div data-testid="transcript-test-root" data-transcript-scroll-root>
          {children}
        </div>
      </QueryClientProvider>
    );
  };
}

function enterViewport(): void {
  if (!intersectionCallback) {
    throw new Error("IntersectionObserver was not registered");
  }
  act(() => {
    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

beforeEach(() => {
  intersectionCallback = null;
  intersectionRoot = null;
  intersectionRootMargin = "";
  useAssistantIdentityStore.getState().clearIdentity();
  fetchAttachmentContentBlob.mockClear();
  fetchAttachmentContentBlob.mockImplementation(
    async () => new Blob(["preview"]),
  );
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  globalThis.IntersectionObserver = TestIntersectionObserver;
  globalThis.URL.createObjectURL = createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

afterAll(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  mock.restore();
});

describe("LazyAttachmentImage", () => {
  test("renders legacy inline data immediately without a query provider or request", () => {
    render(
      <LazyAttachmentImage
        attachmentId="att-inline"
        filename="inline.png"
        inlinePreviewUrl="data:image/png;base64,aW1n"
        size="inline"
      />,
    );

    expect(
      screen.getByTestId("lazy-attachment-image").getAttribute("src"),
    ).toBe("data:image/png;base64,aW1n");
    expect(
      screen.getByTestId("lazy-attachment-image-slot").className,
    ).toContain("max-w-full");
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
  });

  test("fetches display bytes only after entering the viewport and keeps stable geometry", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <LazyAttachmentImage
        assistantId="asst-1"
        attachmentId="att-1"
        filename="preview.png"
        inlinePreviewUrl={null}
        size="inline"
      />,
      { wrapper: createWrapper(queryClient) },
    );
    const slot = screen.getByTestId("lazy-attachment-image-slot");
    const placeholderClass = slot.className;
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(intersectionRoot).toBe(screen.getByTestId("transcript-test-root"));
    });
    expect(intersectionRootMargin).toBe("400px 0px");

    enterViewport();

    await waitFor(() => {
      expect(screen.getByTestId("lazy-attachment-image")).toBeTruthy();
    });
    expect(fetchAttachmentContentBlob).toHaveBeenCalledTimes(1);
    expect(fetchAttachmentContentBlob.mock.calls[0]).toMatchObject([
      "asst-1",
      "att-1",
      { representation: "display" },
    ]);
    expect(fetchAttachmentContentBlob.mock.calls[0]![2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(slot.className).toBe(placeholderClass);

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:display-preview");
    queryClient.clear();
  });

  test("omits the representation query for unknown, old, and mismatched assistants", async () => {
    const cases = [
      { version: null, owner: null, attachmentId: "att-unknown" },
      { version: "0.10.11", owner: "asst-1", attachmentId: "att-old" },
      {
        version: "0.10.12",
        owner: "asst-other",
        attachmentId: "att-mismatch",
      },
    ] as const;

    for (const scenario of cases) {
      useAssistantIdentityStore.getState().clearIdentity();
      if (scenario.version) {
        useAssistantIdentityStore
          .getState()
          .setIdentity("assistant", scenario.version, scenario.owner);
      }
      fetchAttachmentContentBlob.mockClear();
      intersectionCallback = null;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const view = render(
        <LazyAttachmentImage
          assistantId="asst-1"
          attachmentId={scenario.attachmentId}
          filename="preview.png"
          inlinePreviewUrl={null}
          size="inline"
        />,
        { wrapper: createWrapper(queryClient) },
      );
      enterViewport();

      await waitFor(() => {
        expect(fetchAttachmentContentBlob).toHaveBeenCalledTimes(1);
      });
      const options = fetchAttachmentContentBlob.mock.calls[0]![2]!;
      expect("representation" in options).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);

      view.unmount();
      queryClient.clear();
    }
  });

  test("uses a distinct display query after assistant support hydrates", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.11", "asst-1");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <LazyAttachmentImage
        assistantId="asst-1"
        attachmentId="att-transition"
        filename="preview.png"
        inlinePreviewUrl={null}
        size="inline"
      />,
      { wrapper: createWrapper(queryClient) },
    );
    enterViewport();
    await waitFor(() => {
      expect(fetchAttachmentContentBlob).toHaveBeenCalledTimes(1);
    });
    expect(
      "representation" in fetchAttachmentContentBlob.mock.calls[0]![2]!,
    ).toBe(false);

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.12", "asst-1");
    });

    await waitFor(() => {
      expect(fetchAttachmentContentBlob).toHaveBeenCalledTimes(2);
    });
    expect(fetchAttachmentContentBlob.mock.calls[1]![2]).toMatchObject({
      representation: "display",
    });
    expect(
      queryClient.getQueryData([
        "attachmentContent",
        "original",
        "asst-1",
        "att-transition",
      ]),
    ).toBeInstanceOf(Blob);
    expect(
      queryClient.getQueryData([
        "attachmentContent",
        "display",
        "asst-1",
        "att-transition",
      ]),
    ).toBeInstanceOf(Blob);

    view.unmount();
    queryClient.clear();
  });

  test("cancels an in-flight display request when the image unmounts", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    let requestSignal: AbortSignal | undefined;
    fetchAttachmentContentBlob.mockImplementation(
      async (_assistantId, _attachmentId, options) => {
        requestSignal = options?.signal;
        return await new Promise<Blob>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const queryClient = new QueryClient();
    const view = render(
      <LazyAttachmentImage
        assistantId="asst-1"
        attachmentId="att-cancel"
        filename="cancel.png"
        inlinePreviewUrl={null}
        size="square"
      />,
      { wrapper: createWrapper(queryClient) },
    );
    enterViewport();
    await waitFor(() => expect(requestSignal).toBeDefined());

    view.unmount();

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    queryClient.clear();
  });

  test("settles on a non-broken fallback when display bytes are unavailable", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    fetchAttachmentContentBlob.mockImplementation(async () => null);
    const onDecodeError = mock(() => undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <LazyAttachmentImage
        assistantId="asst-1"
        attachmentId="att-error"
        filename="error.png"
        inlinePreviewUrl={null}
        size="inline"
        onDecodeError={onDecodeError}
      />,
      { wrapper: createWrapper(queryClient) },
    );
    enterViewport();

    await waitFor(() => {
      expect(
        screen
          .getByTestId("lazy-attachment-image-slot")
          .getAttribute("data-preview-state"),
      ).toBe("error");
    });
    expect(screen.queryByTestId("lazy-attachment-image")).toBeNull();
    expect(
      screen.getByTestId("lazy-attachment-image-placeholder"),
    ).toBeTruthy();
    expect(onDecodeError).not.toHaveBeenCalled();
    queryClient.clear();
  });

  test("keeps BubbleAttachments in its large slot when a remote preview request fails", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    fetchAttachmentContentBlob.mockImplementation(async () => null);
    const attachment: DisplayAttachment = {
      id: "att-bubble-error",
      filename: "scan.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 4_096,
      previewUrl: null,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <BubbleAttachments attachments={[attachment]} assistantId="asst-1" />,
      { wrapper: createWrapper(queryClient) },
    );
    enterViewport();

    await waitFor(() => {
      expect(
        screen
          .getByTestId("lazy-attachment-image-slot")
          .getAttribute("data-preview-state"),
      ).toBe("error");
    });
    expect(screen.getByTestId("lazy-attachment-image-slot").className).toContain(
      "h-64",
    );
    expect(screen.getByRole("button", { name: "scan.jpg" })).toBeTruthy();
    expect(screen.queryByText("scan.jpg")).toBeNull();
    queryClient.clear();
  });
});
