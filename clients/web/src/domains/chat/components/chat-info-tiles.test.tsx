/**
 * The Chat Info tiles: what each kind draws, and which of them fetch bytes.
 *
 * An attachment's bytes are seeded (or failed) on the test's own query client,
 * under the key the tile reads, rather than by replacing the fetcher module,
 * so nothing this suite does reaches another file's module graph.
 *
 * Glyphs are located by their lucide class because the tile draws them
 * decoratively, with no accessible name of their own; everything else is
 * asserted through accessible names and the rendered image source.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";

import {
  CHAT_INFO_OBJECT_URL,
  CHAT_INFO_TEST_LOCALE,
  chatInfoAppHtmlCacheMock,
  installChatInfoDomStubs,
  makeAppSummary,
  makeChatInfoQueryClient,
  makeDocumentAsset,
  makeDocumentSummary,
  makeFileAsset,
  makeFrameAsset,
  seedChatInfoConversation,
  seedQueryFailure,
} from "@/domains/chat/components/chat-info.test-helper";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import { stubHostLanguage } from "@/i18n/host-language.test-helper";

const restoreDomStubs = installChatInfoDomStubs();
// The capture-time label formats in the host language when it shares a primary
// language with the app's, so both axes are pinned to read the same strings.
const restoreHostLanguage = stubHostLanguage(CHAT_INFO_TEST_LOCALE);

// The app tile's live preview would otherwise call the daemon's open endpoint.
mock.module("@/utils/app-html-cache", chatInfoAppHtmlCacheMock);

const { ChatInfoAppTile } =
  await import("@/domains/chat/components/chat-info-app-tile");
const { ChatInfoFileTile } =
  await import("@/domains/chat/components/chat-info-file-tile");
const { makeDisplayAttachment, SAMPLE_PREVIEWS } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");
const { attachmentContentQueryKey } =
  await import("@/domains/chat/components/chat-attachments/use-attachment-object-url");
const { formatCaptureTime } = await import("@/utils/format-date");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";

const APP = makeAppSummary({ id: "app-1", name: "Trip Planner" });
const DOCUMENT_ASSET = makeDocumentAsset(
  makeDocumentSummary({ title: "Trip Notes" }),
);

/** The bytes the daemon would return for one attachment. */
function seedBytes(attachmentId: string) {
  return (client: QueryClient) => {
    client.setQueryData(
      attachmentContentQueryKey(ASSISTANT_ID, attachmentId),
      new Blob(["image-bytes"], { type: "image/png" }),
    );
  };
}

/** The state a fetch that resolved nothing leaves behind. */
function seedFetchFailure(attachmentId: string) {
  return (client: QueryClient) => {
    seedQueryFailure(
      client,
      attachmentContentQueryKey(ASSISTANT_ID, attachmentId),
    );
  };
}

function renderTile(ui: ReactElement, seed?: (client: QueryClient) => void) {
  const client = makeChatInfoQueryClient();
  // Seeded so the options menu's pin lookup never reaches the daemon.
  seedChatInfoConversation(client, {
    assistantId: ASSISTANT_ID,
    conversationId: CONVERSATION_ID,
    apps: [APP],
  });
  seed?.(client);
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

/** Asserts the tile never asked the daemon for this attachment's bytes. */
function expectNoFetch(client: QueryClient, attachmentId: string) {
  const state = client.getQueryState(
    attachmentContentQueryKey(ASSISTANT_ID, attachmentId),
  );
  expect(state?.fetchStatus ?? "idle").toBe("idle");
  expect(state?.data).toBeUndefined();
}

afterEach(() => {
  cleanup();
});

afterAll(() => {
  restoreDomStubs();
  restoreHostLanguage();
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
    const file = makeFileAsset(
      makeDisplayAttachment({
        id: "inline-1",
        filename: "harbour.png",
        previewUrl: SAMPLE_PREVIEWS[0]!,
      }),
    );
    const { container, client } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      SAMPLE_PREVIEWS[0]!,
    );
    expectNoFetch(client, "inline-1");
    expect(screen.getByLabelText("Preview harbour.png")).toBeDefined();
  });

  test("renders the object URL for bytes the cache holds", async () => {
    const file = makeFileAsset(
      makeDisplayAttachment({ id: "lazy-1", filename: "photo.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
      seedBytes("lazy-1"),
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toBeTruthy();
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      CHAT_INFO_OBJECT_URL,
    );
  });

  test("falls back to the image glyph when the bytes will not decode", async () => {
    const file = makeFileAsset(
      makeDisplayAttachment({ id: "broken-1", filename: "broken.png" }),
    );
    const { container } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
      seedBytes("broken-1"),
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toBeTruthy();
    });
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-file-image")).toBeTruthy();
  });

  test("falls back to the image glyph when the fetch resolves nothing", () => {
    // Without an IntersectionObserver the tile counts as on screen from its
    // first render, so the failed entry is read on mount, where
    // `retryOnMount: false` leaves it failed rather than asking again.
    const observer = globalThis.IntersectionObserver;
    // @ts-expect-error the tile has a branch for a browser without one.
    delete globalThis.IntersectionObserver;
    try {
      const file = makeFileAsset(
        makeDisplayAttachment({ id: "missing-1", filename: "missing.png" }),
      );
      const { container, client } = renderTile(
        <ChatInfoFileTile
          file={file}
          assistantId={ASSISTANT_ID}
          onOpen={() => {}}
        />,
        seedFetchFailure("missing-1"),
      );

      expect(container.querySelector(".lucide-file-image")).toBeTruthy();
      expect(container.querySelector("img")).toBeNull();
      expect(
        client.getQueryState(
          attachmentContentQueryKey(ASSISTANT_ID, "missing-1"),
        )?.fetchStatus,
      ).toBe("idle");
    } finally {
      globalThis.IntersectionObserver = observer;
    }
  });

  test("falls back to the image glyph for a legacy image it can never fetch", () => {
    // A row reloaded from a summary line carries a synthetic id and no bytes.
    const file = makeFileAsset(
      makeDisplayAttachment({ id: "rehydrated:0", filename: "legacy.png" }),
    );
    const { container, client } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector(".lucide-file-image")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expectNoFetch(client, "rehydrated:0");
  });

  test("renders the PDF glyph without fetching", () => {
    const file = makeFileAsset(
      makeDisplayAttachment({
        id: "pdf-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
      }),
    );
    const { container, client } = renderTile(
      <ChatInfoFileTile
        file={file}
        assistantId={ASSISTANT_ID}
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector(".lucide-file-type-corner")).toBeTruthy();
    expectNoFetch(client, "pdf-1");
  });
});

describe("ChatInfoFileTile camera frames", () => {
  function frameAsset(capturedAt: number): ConversationFileAsset {
    return makeFrameAsset(
      makeDisplayAttachment({
        id: "frame-1",
        filename: "frame-01.jpg",
        mimeType: "image/jpeg",
        previewUrl: SAMPLE_PREVIEWS[1]!,
      }),
      capturedAt,
    );
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
      screen.getByText(formatCaptureTime(capturedAt, CHAT_INFO_TEST_LOCALE)),
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
      screen.getByText(formatCaptureTime(capturedAt, CHAT_INFO_TEST_LOCALE)),
    ).toBeDefined();
    expect(screen.getByText(/2001/)).toBeDefined();
  });
});
