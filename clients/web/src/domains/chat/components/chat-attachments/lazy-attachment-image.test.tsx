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
  () => ({ fetchAttachmentContentBlob }),
);

const { LazyAttachmentImage } = await import(
  "@/domains/chat/components/chat-attachments/lazy-attachment-image"
);

let intersectionCallback: IntersectionObserverCallback | null = null;
const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
const createObjectURL = mock(() => "blob:display-preview");
const revokeObjectURL = mock((_url: string) => undefined);

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds = [0];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    intersectionCallback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
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
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
  });

  test("fetches display bytes only after entering the viewport and keeps stable geometry", async () => {
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

  test("cancels an in-flight display request when the image unmounts", async () => {
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
    fetchAttachmentContentBlob.mockImplementation(async () => null);
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
    queryClient.clear();
  });
});
