/**
 * Tests for the composer's attachment strip: which attachments the mobile
 * composer shows as tiles, which keep the chip there, and that desktop keeps
 * the chip for all of them.
 *
 * Mounted with `@testing-library/react` (happy-dom, see
 * `clients/web/test-setup.ts`) against the real chips, the real tile and the
 * real preview modal, so what is asserted is the strip's actual dispatch
 * rather than a stub's.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ChatAttachmentsStrip } from "@/domains/chat/components/chat-attachments/chat-attachments";
import type {
  ChatAttachment,
  FailedAttachmentUpload,
  PendingAttachmentUpload,
  UploadedAttachment,
} from "@/domains/chat/composer-store";

afterEach(() => {
  cleanup();
});

const PREVIEW_URL = "data:image/png;base64,AAAA";

function uploaded(
  overrides: Partial<UploadedAttachment> = {},
): UploadedAttachment {
  return {
    kind: "uploaded",
    localId: "local-1",
    id: "att-1",
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1_024,
    previewUrl: PREVIEW_URL,
    ...overrides,
  };
}

function uploading(
  overrides: Partial<PendingAttachmentUpload> = {},
): PendingAttachmentUpload {
  return {
    kind: "uploading",
    localId: "local-2",
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 2_048,
    ...overrides,
  };
}

function failed(
  overrides: Partial<FailedAttachmentUpload> = {},
): FailedAttachmentUpload {
  return {
    kind: "failed",
    localId: "local-3",
    filename: "broken.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 512,
    error: "Upload failed",
    ...overrides,
  };
}

function renderStrip(
  attachments: ChatAttachment[],
  props: Partial<Parameters<typeof ChatAttachmentsStrip>[0]> = {},
) {
  const onRemove = mock((_localId: string) => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <ChatAttachmentsStrip
        attachments={attachments}
        onRemove={onRemove}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...result, onRemove };
}

/** The scrolling row itself, which is the strip's first rendered element. */
function stripRow(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function tiles(): Element[] {
  return Array.from(document.querySelectorAll('[data-slot="attachment-tile"]'));
}

describe("ChatAttachmentsStrip tiles", () => {
  test("shows an uploaded image as a tile with no caption", () => {
    renderStrip([uploaded()], { tileImages: true });

    expect(tiles()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Preview photo.jpg" }),
    ).toBeTruthy();
    // The chip is what carries a filename; the tile identifies the attachment
    // by the picture alone.
    expect(screen.queryByText("photo.jpg")).toBeNull();
  });

  test("shows an image still uploading as a spinner tile", () => {
    renderStrip([uploading()], { tileImages: true });

    expect(tiles()).toHaveLength(1);
    expect(
      screen.getByRole("img", { name: "Uploading shot.png" }),
    ).toBeTruthy();
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  test("shows an image whose type is a generic blob as a tile", () => {
    renderStrip(
      [
        uploading({
          filename: "photo.jpg",
          mimeType: "application/octet-stream",
        }),
      ],
      { tileImages: true },
    );

    expect(tiles()).toHaveLength(1);
    expect(
      screen.getByRole("img", { name: "Uploading photo.jpg" }),
    ).toBeTruthy();
  });

  test("keeps the chip for a non-image attachment", () => {
    renderStrip(
      [
        uploaded({
          filename: "report.pdf",
          mimeType: "application/pdf",
          previewUrl: null,
        }),
      ],
      { tileImages: true },
    );

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("report.pdf")).toBeTruthy();
  });

  test("keeps the chip for an image with no decodable preview", () => {
    renderStrip([uploaded({ previewUrl: null })], { tileImages: true });

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("photo.jpg")).toBeTruthy();
  });

  test("falls back to the chip when the tile preview cannot decode", () => {
    renderStrip([uploaded()], { tileImages: true });

    const image = document.querySelector('[data-slot="attachment-tile"] img');
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("photo.jpg")).toBeTruthy();
  });

  test("keeps the error chip for a failed image upload", () => {
    renderStrip([failed()], { tileImages: true });

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("broken.jpg")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });

  test("removes the attachment the tile's control names", () => {
    const { onRemove } = renderStrip([uploaded()], { tileImages: true });

    fireEvent.click(screen.getByRole("button", { name: "Remove photo.jpg" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("local-1");
  });

  test("routes the composer's press guard to the tile's control", () => {
    const pressGuard = mock(() => {});
    renderStrip([uploaded()], { tileImages: true, pressGuard });

    fireEvent.mouseDown(
      screen.getByRole("button", { name: "Remove photo.jpg" }),
    );
    expect(pressGuard).toHaveBeenCalledTimes(1);
  });

  test("opens the preview modal from the tile image", () => {
    renderStrip([uploaded()], { tileImages: true });

    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview photo.jpg" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByAltText("photo.jpg").getAttribute("src")).toBe(
      PREVIEW_URL,
    );
  });
});

describe("ChatAttachmentsStrip chips", () => {
  test("keeps the chip for every attachment without the tile opt-in", () => {
    const { container } = renderStrip([uploaded(), uploading()]);

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("photo.jpg")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(stripRow(container).className).toContain("pt-2");
  });

  test("opens the row's top inset for a tile row", () => {
    const { container } = renderStrip([uploaded()], { tileImages: true });

    expect(stripRow(container).className).toContain("pt-3");
  });
});
