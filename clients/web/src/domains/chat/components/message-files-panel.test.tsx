/**
 * Tests for `MessageFilesPanel` - the side drawer listing every attachment on
 * one transcript message.
 *
 *  - Renders one square per attachment, media and non-media alike, from the
 *    payload snapshot when no live message resolves.
 *  - The header count matches the attachment total.
 *  - The close button fires `onClose`.
 *  - Clicking a square opens the shared preview modal with the whole set as
 *    gallery siblings.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { DisplayAttachment } from "@/types/attachment-types";

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-preview-modal",
  () => ({
    AttachmentPreviewModal: ({
      attachment,
      siblingAttachments,
    }: {
      attachment: { id: string };
      siblingAttachments?: Array<{ id: string }>;
    }) => (
      <div
        data-testid="preview-modal"
        data-attachment-id={attachment.id}
        data-sibling-count={String((siblingAttachments ?? []).length)}
      />
    ),
  }),
);

const { MessageFilesPanel } = await import(
  "@/domains/chat/components/message-files-panel"
);

afterEach(() => {
  cleanup();
});

const ATTACHMENTS: DisplayAttachment[] = [
  {
    id: "img-0",
    filename: "photo-0.png",
    mimeType: "image/png",
    sizeBytes: 1_024,
    previewUrl: "https://example.com/photo-0.png",
  },
  {
    id: "deck-1",
    filename: "deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 4_096,
    previewUrl: null,
  },
  {
    id: "report-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_048,
    previewUrl: null,
  },
  {
    id: "bundle-1",
    filename: "bundle.zip",
    mimeType: "application/zip",
    sizeBytes: 8_192,
    previewUrl: null,
  },
];

function renderPanel(onClose: () => void = () => {}) {
  return render(
    <MessageFilesPanel
      payload={{ attachments: ATTACHMENTS }}
      onClose={onClose}
    />,
  );
}

/** The squares are divs with `role="button"`; the download affordance is a
 *  real `<button>`, so this selector counts only attachment squares. */
function squareLabels(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll('div[role="button"]')).map(
    (el) => el.getAttribute("aria-label"),
  );
}

describe("MessageFilesPanel", () => {
  test("renders one square per attachment, media and non-media alike", () => {
    const { container } = renderPanel();
    expect(squareLabels(container)).toEqual([
      "photo-0.png",
      "deck.pptx",
      "report.pdf",
      "bundle.zip",
    ]);
  });

  test("header count matches the attachment total", () => {
    const { getByText } = renderPanel();
    expect(getByText("Files · 4")).toBeTruthy();
  });

  test("close button fires onClose", () => {
    let closed = false;
    const { getByLabelText } = renderPanel(() => {
      closed = true;
    });
    fireEvent.click(getByLabelText("Close files"));
    expect(closed).toBe(true);
  });

  test("clicking a square opens the preview with the whole set as siblings", () => {
    const { getByLabelText, getByTestId } = renderPanel();
    fireEvent.click(getByLabelText("report.pdf"));

    const modal = getByTestId("preview-modal");
    expect(modal.getAttribute("data-attachment-id")).toBe("report-1");
    expect(modal.getAttribute("data-sibling-count")).toBe("4");
  });
});
