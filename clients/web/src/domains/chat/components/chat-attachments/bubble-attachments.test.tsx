import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-preview-modal",
  () => ({
    AttachmentPreviewModal: ({
      attachment,
    }: {
      attachment: { id: string; previewUrl: string | null };
    }) => (
      <div
        data-testid="preview-modal"
        data-attachment-id={attachment.id}
        data-preview-url={String(attachment.previewUrl)}
      />
    ),
  }),
);

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { BubbleAttachments } from "@/domains/chat/components/chat-attachments/bubble-attachments";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});

const imageWithPreview: DisplayAttachment = {
  id: "img-1",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 12_345,
  previewUrl: "https://example.com/photo.png",
};

const pdf: DisplayAttachment = {
  id: "pdf-1",
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2_048,
  previewUrl: null,
};

const imageWithoutPreview: DisplayAttachment = {
  id: "img-2",
  filename: "scan.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 4_096,
  previewUrl: null,
};

describe("BubbleAttachments", () => {
  test("renders an image with a preview as a large inline preview without filename/size", () => {
    const { getByRole, queryByText } = render(
      <BubbleAttachments attachments={[imageWithPreview]} />,
    );

    const img = getByRole("button", { name: "photo.png" });
    expect(img.getAttribute("src")).toBe("https://example.com/photo.png");
    expect(queryByText("photo.png")).toBeNull();
    expect(queryByText("12 KB")).toBeNull();
  });

  test("renders a non-image attachment as a square chip with filename and size", () => {
    const { getByText } = render(<BubbleAttachments attachments={[pdf]} />);

    expect(getByText("report.pdf")).toBeTruthy();
    expect(getByText("2.0 KB")).toBeTruthy();
  });

  test("falls back to the square chip for an image without a preview", () => {
    const { getByText } = render(
      <BubbleAttachments attachments={[imageWithoutPreview]} />,
    );

    expect(getByText("scan.jpg")).toBeTruthy();
  });

  test("opens the preview modal when an attachment is clicked", () => {
    const { getByRole, getByTestId } = render(
      <BubbleAttachments attachments={[imageWithPreview]} />,
    );

    fireEvent.click(getByRole("button", { name: "photo.png" }));

    expect(getByTestId("preview-modal").getAttribute("data-attachment-id")).toBe(
      "img-1",
    );
  });

  test("preserves the original attachment order for a mixed list", () => {
    const { getByText, getByRole } = render(
      <BubbleAttachments attachments={[pdf, imageWithPreview]} />,
    );

    const pdfEl = getByText("report.pdf");
    const imgEl = getByRole("button", { name: "photo.png" });

    // The pdf chip must appear before the image preview in document order,
    // matching the input order [pdf, image].
    expect(
      pdfEl.compareDocumentPosition(imgEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("returns null for an empty attachments array", () => {
    const { container } = render(<BubbleAttachments attachments={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("falls back to the square chip when the inline image fails to decode", () => {
    const undecodable: DisplayAttachment = {
      id: "img-3",
      filename: "IMG_5487.HEIC",
      mimeType: "image/heic",
      sizeBytes: 1_024,
      previewUrl: "blob:undecodable-heic",
    };
    const { container, getByRole, getByText } = render(
      <BubbleAttachments attachments={[undecodable]} />,
    );

    fireEvent.error(getByRole("button", { name: "IMG_5487.HEIC" }));

    // The browser's broken-image glyph is replaced by the chip: the filename
    // becomes visible and no <img> remains mounted.
    expect(getByText("IMG_5487.HEIC")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  test("opens the preview with a sanitized (null) previewUrl after the inline image fails to decode", () => {
    const undecodable: DisplayAttachment = {
      id: "img-4",
      filename: "IMG_9999.HEIC",
      mimeType: "image/heic",
      sizeBytes: 2_048,
      previewUrl: "blob:undecodable-heic",
    };
    const { getByRole, getByTestId } = render(
      <BubbleAttachments attachments={[undecodable]} />,
    );

    // Decode fails -> falls back to the chip.
    fireEvent.error(getByRole("button", { name: "IMG_9999.HEIC" }));
    // Clicking the fallback chip opens the modal with the dead previewUrl
    // stripped, so the modal fetches stored bytes instead of the broken blob.
    fireEvent.click(getByRole("button", { name: "IMG_9999.HEIC" }));

    const modal = getByTestId("preview-modal");
    expect(modal.getAttribute("data-attachment-id")).toBe("img-4");
    expect(modal.getAttribute("data-preview-url")).toBe("null");
  });
});
