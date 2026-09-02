import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import type { DisplayAttachment } from "@/types/attachment-types";

type ContentResult = { data: Blob | null; error: { message: string } | null };

// Mock only the daemon content endpoint; keep the rest of the generated SDK
// real so any other consumer in the module graph is unaffected.
const attachmentsByIdContentGet = mock(async (): Promise<ContentResult> => ({
  data: new Blob(["content"]),
  error: null,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

// happy-dom doesn't implement object URLs.
globalThis.URL.createObjectURL = mock(
  (_obj: Blob | MediaSource): string => "blob:preview-mock",
);
globalThis.URL.revokeObjectURL = mock((_url: string): void => undefined);

const { AttachmentPreviewModal } =
  await import("@/domains/chat/components/chat-attachments/attachment-preview-modal");

const ATTACHMENT: DisplayAttachment = {
  id: "att-1",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  previewUrl: null,
};

function renderModal(
  attachment: DisplayAttachment,
  onClose: () => void = () => undefined,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <AttachmentPreviewModal
        open
        onClose={onClose}
        attachment={attachment}
        assistantId="asst-1"
      />
    </QueryClientProvider>
  );
  render(ui);
}

afterEach(() => {
  cleanup();
  attachmentsByIdContentGet.mockClear();
});

describe("AttachmentPreviewModal content loading", () => {
  test("renders an inline previewUrl without hitting the daemon", () => {
    renderModal({ ...ATTACHMENT, previewUrl: "data:image/png;base64,AAAA" });

    expect(screen.getByAltText("photo.png").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("renders a generic-MIME image by its extension", () => {
    renderModal({
      ...ATTACHMENT,
      filename: "photo.jpg",
      mimeType: "application/octet-stream",
      previewUrl: "data:image/png;base64,AAAA",
    });

    expect(screen.getByAltText("photo.jpg").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  test("routes a generic-MIME name with a trailing space to the text preview", async () => {
    // The shared extension parser trims, so classification and preview routing
    // read the same extension for a name a picker padded with whitespace.
    const text = "notes body";
    renderModal({
      ...ATTACHMENT,
      filename: "notes.txt ",
      mimeType: "application/octet-stream",
      previewUrl: `data:text/plain;base64,${btoa(text)}`,
    });

    expect(await screen.findByText(text)).toBeDefined();
  });

  test("shows a clear message for rehydrated attachments and never fetches", () => {
    renderModal({ ...ATTACHMENT, id: "rehydrated:abc" });

    expect(
      screen.getByText(
        "Preview unavailable — file content was not preserved in chat history.",
      ),
    ).toBeDefined();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("fetches from the daemon and renders the resulting object URL", async () => {
    renderModal(ATTACHMENT);

    const img = await screen.findByAltText("photo.png");
    expect(img.getAttribute("src")).toBe("blob:preview-mock");
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
  });

  test("shows the failure fallback when the daemon fetch fails", async () => {
    attachmentsByIdContentGet.mockImplementationOnce(async () => ({
      data: null,
      error: { message: "boom" },
    }));
    renderModal(ATTACHMENT);

    expect(await screen.findByText("Failed to load preview.")).toBeDefined();
  });

  test("falls back to the non-image card when the fetched image can't be decoded", async () => {
    renderModal(ATTACHMENT);

    const img = await screen.findByAltText("photo.png");
    fireEvent.error(img);

    // The broken image is replaced by the non-image fallback card (file icon +
    // download), so an undecodable full-size image never shows a broken glyph.
    expect(screen.queryByAltText("photo.png")).toBeNull();
    expect(screen.getByText("Download")).toBeDefined();
  });

  test("renders a video with a thumbnail poster and fetches content from the daemon", async () => {
    const videoAttachment: DisplayAttachment = {
      id: "att-video",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5_000_000,
      previewUrl: null,
      thumbnailUrl: "data:image/jpeg;base64,AAAA",
    };
    renderModal(videoAttachment);

    // The <video> element should appear with the thumbnail as its poster and
    // the fetched blob URL as its src — NOT the thumbnail as src (the bug).
    const video = await screen.findByTestId("video-preview");
    expect(video.getAttribute("poster")).toBe("data:image/jpeg;base64,AAAA");
    expect(video.getAttribute("src")).toBe("blob:preview-mock");
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
  });

  test("small video with inline data still lazy-fetches to blob URL (CSP fix)", async () => {
    // Simulates what deriveDisplayUrls produces for a small video that DID
    // arrive with inline data: previewUrl is null (not a data: URI) because
    // Electron CSP media-src allows blob: but not data:.
    const smallVideo: DisplayAttachment = {
      id: "att-small-video",
      filename: "small.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100_000,
      previewUrl: null,
      thumbnailUrl: "data:image/jpeg;base64,BBBB",
    };
    renderModal(smallVideo);

    const video = await screen.findByTestId("video-preview");
    // src must be a blob URL, not a data: URI — CSP-safe for Electron.
    expect(video.getAttribute("src")).toBe("blob:preview-mock");
    expect(video.getAttribute("poster")).toBe("data:image/jpeg;base64,BBBB");
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
  });
});

/**
 * The top bar is click-through so it cannot swallow clicks on the preview
 * underneath it, which on a short viewport reaches under the bar. Its own
 * content still has to take its own clicks: the filename label spans the whole
 * middle of the bar, so a click-through label would put the backdrop under the
 * pointer and dismiss the preview.
 */
describe("AttachmentPreviewModal top bar", () => {
  // Asserted structurally: happy-dom does no pointer-events hit testing, so a
  // synthetic click always lands on the element it is dispatched to and cannot
  // distinguish a click-through label from an inert one.
  test("takes pointer events on the filename label, not its full-width track", () => {
    renderModal({ ...ATTACHMENT, previewUrl: "data:image/png;base64,AAAA" });

    const label = screen.getByText("photo.png");
    expect(label.className).toContain("pointer-events-auto");
    expect(label.parentElement?.className).not.toContain("pointer-events-auto");
  });

  test("the close button still closes the preview", () => {
    let closed = 0;
    renderModal(
      { ...ATTACHMENT, previewUrl: "data:image/png;base64,AAAA" },
      () => {
        closed += 1;
      },
    );

    fireEvent.click(screen.getByLabelText("Close preview"));

    expect(closed).toBe(1);
  });
});
