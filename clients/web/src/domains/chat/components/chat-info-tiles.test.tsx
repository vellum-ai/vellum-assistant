/**
 * The Chat Info tiles: what each kind draws, and which of them fetch bytes.
 *
 * Glyphs are located by their lucide class because the tile draws them
 * decoratively, with no accessible name of their own; everything else is
 * asserted through accessible names and the rendered image source.
 */

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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";

import * as appHtmlCache from "@/utils/app-html-cache";
import * as downloadAttachmentModule from "@/domains/chat/components/chat-attachments/download-attachment";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";

const OBJECT_URL = "blob:chat-info-tile";

// happy-dom implements neither object URLs nor IntersectionObserver.
globalThis.URL.createObjectURL = mock(
  (_obj: Blob | MediaSource): string => OBJECT_URL,
);
globalThis.URL.revokeObjectURL = mock((_url: string): void => undefined);

class ImmediateIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: number[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
globalThis.IntersectionObserver =
  ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;

const fetchAttachmentContentBlob = mock(
  async (_assistantId: string, _attachmentId: string): Promise<Blob | null> =>
    new Blob(["image-bytes"], { type: "image/png" }),
);
// Both factories keep the rest of their module real, so a file that imports
// another of its exports is unaffected by these process-global replacements.
mock.module(
  "@/domains/chat/components/chat-attachments/download-attachment",
  (): Partial<typeof downloadAttachmentModule> => ({
    ...downloadAttachmentModule,
    fetchAttachmentContentBlob,
  }),
);

// The app tile's live preview would otherwise call the daemon's open endpoint.
mock.module(
  "@/utils/app-html-cache",
  (): Partial<typeof appHtmlCache> => ({
    ...appHtmlCache,
    getCachedAppHtml: async () => "<!doctype html><title>App</title>",
  }),
);

const { ChatInfoAppTile } =
  await import("@/domains/chat/components/chat-info-app-tile");
const { ChatInfoFileTile } =
  await import("@/domains/chat/components/chat-info-file-tile");
const { makeDisplayAttachment, SAMPLE_PREVIEWS } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");
const { appsGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { formatCaptureTime } = await import("@/utils/format-date");
type ConversationFileAsset =
  import("@/domains/chat/hooks/use-conversation-assets").ConversationFileAsset;

const ASSISTANT_ID = "asst-1";

const APP: AppSummary = {
  id: "app-1",
  name: "Trip Planner",
  icon: "🧭",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  version: "1.0.0",
  contentId: "content-1",
  origin: "workspace",
};

const DOC: DocumentSummary = {
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Trip Notes",
  wordCount: 120,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
};

const DOCUMENT_ASSET: ConversationFileAsset = {
  kind: "document",
  id: "doc-surface-1",
  title: DOC.title,
  doc: DOC,
};

function attachmentAsset(
  attachment: ReturnType<typeof makeDisplayAttachment>,
): ConversationFileAsset {
  return {
    kind: "attachment",
    id: `att-${attachment.id}`,
    title: attachment.filename,
    attachment,
  };
}

function renderTile(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seeded so the options menu's pin lookup never reaches the daemon.
  client.setQueryData(
    appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    {
      apps: [APP],
    },
  );
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchAttachmentContentBlob.mockClear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

describe("ChatInfoAppTile", () => {
  test("opens the app by id and offers its options menu", async () => {
    const onOpen = mock((_appId: string): void => undefined);
    const { container } = renderTile(
      <ChatInfoAppTile
        app={APP}
        assistantId={ASSISTANT_ID}
        onOpen={onOpen}
        onRequestDelete={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open Trip Planner"));

    expect(onOpen).toHaveBeenCalledWith("app-1");
    expect(screen.getByLabelText("Options for Trip Planner")).toBeDefined();
    // The preview loads its html asynchronously; settle it inside the test.
    await waitFor(() => {
      expect(container.querySelector("iframe")).toBeTruthy();
    });
  });
});

describe("ChatInfoFileTile documents", () => {
  test("draws the document glyph and offers its options menu", () => {
    const onOpen = mock((_file: ConversationFileAsset): void => undefined);
    const { container } = renderTile(
      <ChatInfoFileTile
        file={DOCUMENT_ASSET}
        assistantId={ASSISTANT_ID}
        onOpen={onOpen}
      />,
    );

    expect(container.querySelector(".lucide-file-text")).toBeTruthy();
    expect(screen.getByLabelText("Options for Trip Notes")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Open Trip Notes"));
    expect(onOpen).toHaveBeenCalledWith(DOCUMENT_ASSET);
  });
});

describe("ChatInfoFileTile attachments", () => {
  test("renders an inline preview without fetching", () => {
    const file = attachmentAsset(
      makeDisplayAttachment({
        id: "inline-1",
        filename: "harbour.png",
        previewUrl: SAMPLE_PREVIEWS[0]!,
      }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      SAMPLE_PREVIEWS[0]!,
    );
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Preview harbour.png")).toBeDefined();
  });

  test("spins while it fetches, then renders the object URL", async () => {
    const file = attachmentAsset(
      makeDisplayAttachment({ id: "lazy-1", filename: "photo.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector(".lucide-loader-circle")).toBeTruthy();

    await waitFor(() => {
      expect(container.querySelector("img")).toBeTruthy();
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      OBJECT_URL,
    );
    expect(fetchAttachmentContentBlob).toHaveBeenCalledTimes(1);
  });

  test("falls back to the image glyph when the bytes will not decode", async () => {
    const file = attachmentAsset(
      makeDisplayAttachment({ id: "broken-1", filename: "broken.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toBeTruthy();
    });
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-file-image")).toBeTruthy();
  });

  test("falls back to the image glyph when the fetch resolves nothing", async () => {
    fetchAttachmentContentBlob.mockImplementationOnce(async () => null);
    const file = attachmentAsset(
      makeDisplayAttachment({ id: "missing-1", filename: "missing.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".lucide-file-image")).toBeTruthy();
    });
    expect(container.querySelector("img")).toBeNull();
  });

  test("falls back to the image glyph for a legacy image it can never fetch", () => {
    // A row reloaded from a summary line carries a synthetic id and no bytes.
    const file = attachmentAsset(
      makeDisplayAttachment({ id: "rehydrated:0", filename: "legacy.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector(".lucide-file-image")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
  });

  test("renders the PDF glyph without fetching", () => {
    const file = attachmentAsset(
      makeDisplayAttachment({
        id: "pdf-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
      }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector(".lucide-file-type-corner")).toBeTruthy();
    expect(fetchAttachmentContentBlob).not.toHaveBeenCalled();
  });
});

describe("ChatInfoFileTile camera frames", () => {
  // The suite pins i18next to English, which is the locale the tile formats in.
  const LOCALE = "en";

  function frameAsset(capturedAt: number): ConversationFileAsset {
    return {
      kind: "frame",
      id: "frame-1",
      title: "frame-01.jpg",
      attachment: makeDisplayAttachment({
        id: "frame-1",
        filename: "frame-01.jpg",
        mimeType: "image/jpeg",
        previewUrl: SAMPLE_PREVIEWS[1]!,
      }),
      capturedAt,
    };
  }

  test("labels a frame from today with its time of day", () => {
    // Frames from one Live session share a date, so the time is what tells
    // them apart.
    const capturedAt = new Date().setHours(10, 30, 0, 0);
    renderTile(
      <ChatInfoFileTile
        file={frameAsset(capturedAt)}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByLabelText("Preview camera frame")).toBeDefined();
    expect(
      screen.getByText(formatCaptureTime(capturedAt, LOCALE)),
    ).toBeDefined();
  });

  test("labels an older frame with its date", () => {
    const capturedAt = new Date(2001, 4, 27, 10, 30).getTime();
    renderTile(
      <ChatInfoFileTile
        file={frameAsset(capturedAt)}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(
      screen.getByText(formatCaptureTime(capturedAt, LOCALE)),
    ).toBeDefined();
    expect(screen.getByText(/2001/)).toBeDefined();
  });
});
