import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

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

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";
import { useViewerStore } from "@/stores/viewer-store";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
  useViewerStore.setState({ mainView: "chat", activeMessageFiles: null });
});

function image(index: number): DisplayAttachment {
  return {
    id: `img-${index}`,
    filename: `photo-${index}.png`,
    mimeType: "image/png",
    sizeBytes: 1_024,
    previewUrl: `https://example.com/photo-${index}.png`,
  };
}

function images(count: number): DisplayAttachment[] {
  return Array.from({ length: count }, (_, index) => image(index));
}

/** The squares are divs with `role="button"`; the download and overflow
 *  affordances are real `<button>` elements, so this selector counts only
 *  attachment squares. */
function squareLabels(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll('div[role="button"]')).map(
    (el) => el.getAttribute("aria-label"),
  );
}

describe("MessageAttachments", () => {
  test("renders every square and no overflow tile at the visible limit", () => {
    const { container, queryByRole } = render(
      <MessageAttachments attachments={images(5)} />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(queryByRole("button", { name: /Show all files/ })).toBeNull();
  });

  test("renders five squares plus a +1 tile for six attachments", () => {
    const { container, getByText, getByRole } = render(
      <MessageAttachments attachments={images(6)} />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(getByText("+1")).toBeTruthy();
    expect(
      getByRole("button", { name: "Show all files (1 more)" }),
    ).toBeTruthy();
  });

  test("renders five squares plus a +36 tile for forty-one attachments", () => {
    const { container, getByText } = render(
      <MessageAttachments attachments={images(41)} />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(getByText("+36")).toBeTruthy();
  });

  test("counts non-media attachments toward the limit and keeps source order", () => {
    const mixed: DisplayAttachment[] = [
      image(0),
      {
        id: "deck-1",
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: 4_096,
        previewUrl: null,
      },
      image(1),
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
      image(2),
      image(3),
      image(4),
    ];

    const { container, getByText } = render(
      <MessageAttachments attachments={mixed} />,
    );

    expect(squareLabels(container)).toEqual([
      "photo-0.png",
      "deck.pptx",
      "photo-1.png",
      "report.pdf",
      "bundle.zip",
    ]);
    expect(getByText("+3")).toBeTruthy();
  });

  test("the overflow tile opens the files panel with every attachment", () => {
    const { getByRole, queryByTestId } = render(
      <MessageAttachments attachments={images(8)} messageId="msg-1" />,
    );

    fireEvent.click(getByRole("button", { name: "Show all files (3 more)" }));

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("message-files");
    expect(viewer.activeMessageFiles?.messageId).toBe("msg-1");
    expect(viewer.activeMessageFiles?.attachments).toHaveLength(8);
    // The tile targets the panel, so the preview modal stays shut.
    expect(queryByTestId("preview-modal")).toBeNull();
  });

  test("clicking the overflow tile again closes the files panel", () => {
    const { getByRole } = render(
      <MessageAttachments attachments={images(8)} messageId="msg-1" />,
    );

    const tile = getByRole("button", { name: "Show all files (3 more)" });
    fireEvent.click(tile);
    fireEvent.click(tile);

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("chat");
    expect(viewer.activeMessageFiles).toBeNull();
  });

  test("returns null for an empty attachments array", () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
