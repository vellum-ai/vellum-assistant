import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { DisplayAttachment } from "@/types/attachment-types";

type ContentResult = { data: Blob | null; error: { message: string } | null };

// Mock only the daemon content endpoint; keep the rest of the generated SDK
// real so any other consumer in the module graph is unaffected.
const attachmentsByIdContentGet = mock(
  async (_options: {
    query?: { representation?: "original" | "display" };
    signal?: AbortSignal;
  }): Promise<ContentResult> => ({
    data: new Blob(["content"]),
    error: null,
  }),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

const saveFile = mock(async (_data: Blob | string, _filename: string) => {});
mock.module("@/runtime/native-file", () => ({ saveFile }));

// happy-dom doesn't implement object URLs.
globalThis.URL.createObjectURL = mock(
  (_obj: Blob | MediaSource): string => "blob:preview-mock",
);
globalThis.URL.revokeObjectURL = mock((_url: string): void => undefined);

const { AttachmentPreviewModal } = await import(
  "@/domains/chat/components/chat-attachments/attachment-preview-modal"
);

const ATTACHMENT: DisplayAttachment = {
  id: "att-1",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  previewUrl: null,
};

function renderModal(attachment: DisplayAttachment) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <AttachmentPreviewModal
        open
        onClose={() => undefined}
        attachment={attachment}
        assistantId="asst-1"
      />
    </QueryClientProvider>
  );
  return { ...render(ui), client };
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  attachmentsByIdContentGet.mockClear();
  attachmentsByIdContentGet.mockImplementation(async () => ({
    data: new Blob(["content"]),
    error: null,
  }));
  saveFile.mockClear();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("AttachmentPreviewModal content loading", () => {
  test("renders an inline previewUrl without hitting the daemon", () => {
    renderModal({ ...ATTACHMENT, previewUrl: "data:image/png;base64,AAAA" });

    expect(screen.getByAltText("photo.png").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
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

  test("unknown assistants omit the representation and render original bytes", async () => {
    const { client } = renderModal(ATTACHMENT);

    const img = await screen.findByAltText("photo.png");
    expect(img.getAttribute("src")).toBe("blob:preview-mock");
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toBeUndefined();
    expect(
      attachmentsByIdContentGet.mock.calls[0]![0].signal,
    ).toBeInstanceOf(AbortSignal);
    expect(
      client.getQueryData([
        "attachmentContent",
        "original",
        "asst-1",
        ATTACHMENT.id,
      ]),
    ).toBeInstanceOf(Blob);
  });

  test("supported image previews request display bytes under a distinct query key", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    const { client } = renderModal(ATTACHMENT);

    await screen.findByAltText("photo.png");

    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toEqual({
      representation: "display",
    });
    expect(
      attachmentsByIdContentGet.mock.calls[0]![0].signal,
    ).toBeInstanceOf(AbortSignal);
    expect(
      client.getQueryData([
        "attachmentContent",
        "display",
        "asst-1",
        ATTACHMENT.id,
      ]),
    ).toBeInstanceOf(Blob);
    expect(
      client.getQueryData([
        "attachmentContent",
        "original",
        "asst-1",
        ATTACHMENT.id,
      ]),
    ).toBeUndefined();
  });

  test("known legacy assistants omit the display representation", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.11", "asst-1");
    renderModal({ ...ATTACHMENT, id: "att-legacy" });

    await screen.findByAltText("photo.png");

    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toBeUndefined();
    expect(
      attachmentsByIdContentGet.mock.calls[0]![0].signal,
    ).toBeInstanceOf(AbortSignal);
  });

  test("supported HEIC metadata with a generic MIME requests and renders display bytes", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    renderModal({
      ...ATTACHMENT,
      id: "att-heic",
      filename: "photo.heic",
      mimeType: "application/octet-stream",
    });

    await screen.findByAltText("photo.heic");

    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toEqual({
      representation: "display",
    });
  });

  test("unmount aborts the exact display request signal", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    let requestSignal: AbortSignal | undefined;
    attachmentsByIdContentGet.mockImplementationOnce(async (options) => {
      requestSignal = options.signal;
      return await new Promise<ContentResult>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(requestSignal?.reason),
          { once: true },
        );
      });
    });
    const view = renderModal({ ...ATTACHMENT, id: "att-cancel" });
    await waitFor(() => expect(requestSignal).toBeDefined());

    view.unmount();

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
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
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toBeUndefined();
    expect(
      attachmentsByIdContentGet.mock.calls[0]![0].signal,
    ).toBeInstanceOf(AbortSignal);
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

  test("downloads original bytes after rendering a display representation", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    const displayBlob = new Blob(["display"]);
    const originalBlob = new Blob(["original"]);
    attachmentsByIdContentGet
      .mockImplementationOnce(async () => ({ data: displayBlob, error: null }))
      .mockImplementationOnce(async () => ({ data: originalBlob, error: null }));
    renderModal({ ...ATTACHMENT, id: "att-download" });
    await screen.findByAltText("photo.png");

    fireEvent.click(screen.getByLabelText("Download photo.png"));

    await waitFor(() => {
      expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(2);
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toEqual({
      representation: "display",
    });
    expect(attachmentsByIdContentGet.mock.calls[1]![0].query).toBeUndefined();
    expect(saveFile).toHaveBeenCalledWith(originalBlob, "photo.png");
    expect(saveFile).not.toHaveBeenCalledWith(displayBlob, "photo.png");
  });

  test("download falls back to an inline preview when original bytes are unavailable", async () => {
    attachmentsByIdContentGet.mockImplementationOnce(async () => ({
      data: null,
      error: { message: "unavailable" },
    }));
    const previewUrl = "data:image/png;base64,aW5saW5l";
    renderModal({ ...ATTACHMENT, id: "att-inline", previewUrl });

    fireEvent.click(screen.getByLabelText("Download photo.png"));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0].query).toBeUndefined();
    expect(saveFile).toHaveBeenCalledWith(previewUrl, "photo.png");
  });
});
