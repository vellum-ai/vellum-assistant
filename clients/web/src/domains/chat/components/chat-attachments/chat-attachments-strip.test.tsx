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
  PathReferenceAttachment,
  PendingAttachmentUpload,
  UploadedAttachment,
} from "@/domains/chat/composer-store";

afterEach(() => {
  cleanup();
});

const PREVIEW_URL = "data:image/png;base64,AAAA";
const SECOND_PREVIEW_URL = "data:image/png;base64,BBBB";

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

function pathReference(
  overrides: Partial<PathReferenceAttachment> = {},
): PathReferenceAttachment {
  return {
    kind: "path-reference",
    localId: "local-4",
    filename: "project",
    path: "/Users/example/project",
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

  test("keeps the folder row for a path reference", () => {
    renderStrip([pathReference()], { tileImages: true });

    expect(tiles()).toHaveLength(0);
    expect(screen.getByText("project")).toBeTruthy();
    expect(screen.getByText("/Users/example/project")).toBeTruthy();
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

  // Every removal control in the strip wears the guard, so a tap on any of
  // them leaves the textarea focused and the mobile row standing.
  const PRESS_GUARD_CASES: Array<{
    what: string;
    attachment: ChatAttachment;
    control: string;
  }> = [
    { what: "the tile", attachment: uploaded(), control: "Remove photo.jpg" },
    {
      what: "a chip",
      attachment: uploaded({
        filename: "report.pdf",
        mimeType: "application/pdf",
        previewUrl: null,
      }),
      control: "Remove report.pdf",
    },
    {
      what: "an uploading chip",
      attachment: uploading({
        filename: "report.pdf",
        mimeType: "application/pdf",
      }),
      control: "Cancel upload of report.pdf",
    },
    {
      what: "a path reference",
      attachment: pathReference(),
      control: "Remove project",
    },
    {
      what: "a failed upload",
      attachment: failed(),
      control: "Remove broken.jpg",
    },
  ];

  for (const { what, attachment, control } of PRESS_GUARD_CASES) {
    test(`routes the composer's press guard to ${what}`, () => {
      const pressGuard = mock(() => {});
      renderStrip([attachment], { tileImages: true, pressGuard });

      fireEvent.mouseDown(screen.getByRole("button", { name: control }));
      expect(pressGuard).toHaveBeenCalledTimes(1);
    });
  }

  test("opens the preview modal from the tile image", () => {
    renderStrip([uploaded()], { tileImages: true });

    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview photo.jpg" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByAltText("photo.jpg").getAttribute("src")).toBe(
      PREVIEW_URL,
    );
  });

  test("moves between the attached photos inside the lightbox", () => {
    renderStrip(
      [
        uploaded(),
        uploaded({
          localId: "local-5",
          id: "att-2",
          filename: "second.jpg",
          previewUrl: SECOND_PREVIEW_URL,
        }),
      ],
      { tileImages: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview photo.jpg" }));
    expect(screen.getByAltText("photo.jpg")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next attachment" }));
    expect(screen.getByAltText("second.jpg").getAttribute("src")).toBe(
      SECOND_PREVIEW_URL,
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
    // Desktop rows are all one height, so nothing overrides the stretch.
    expect(stripRow(container).className).not.toContain("items-start");
  });

  test("falls back to the kind icon when a chip preview cannot decode", () => {
    renderStrip([uploaded()]);

    const image = screen.getByRole("img", { name: "photo.jpg" });
    fireEvent.error(image.querySelector("img") as HTMLImageElement);

    expect(screen.queryByRole("img", { name: "photo.jpg" })).toBeNull();
    // The chip is still the chip, so the file is still named.
    expect(screen.getByText("photo.jpg")).toBeTruthy();
  });

  test("opens the row's top inset for a tile row", () => {
    const { container } = renderStrip([uploaded()], { tileImages: true });

    expect(stripRow(container).className).toContain("pt-3");
    // A chip beside a 100px tile keeps its own height.
    expect(stripRow(container).className).toContain("items-start");
  });

  test("keeps the stretch for a mobile row with no tile in it", () => {
    const { container } = renderStrip([pathReference()], { tileImages: true });

    // The card inset still applies; only the alignment is keyed on a tile.
    expect(stripRow(container).className).toContain("pt-3");
    expect(stripRow(container).className).not.toContain("items-start");
  });
});
