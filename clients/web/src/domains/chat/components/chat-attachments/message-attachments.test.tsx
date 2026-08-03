import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  makeDisplayAttachment,
  makeImageAttachments,
  mockAttachmentPreviewModal,
  squareLabels,
} from "@/domains/chat/components/chat-attachments/attachment-test-helpers";

mockAttachmentPreviewModal();

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

describe("MessageAttachments", () => {
  test("renders every square and no overflow tile at the visible limit", () => {
    const { container, queryByRole } = render(
      <MessageAttachments
        attachments={makeImageAttachments(5)}
        messageId="msg-1"
      />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(queryByRole("button", { name: /Show all files/ })).toBeNull();
  });

  test("renders five squares plus a +1 tile for six attachments", () => {
    const { container, getByText, getByRole } = render(
      <MessageAttachments
        attachments={makeImageAttachments(6)}
        messageId="msg-1"
      />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(getByText("+1")).toBeTruthy();
    expect(
      getByRole("button", { name: "Show all files (1 more)" }),
    ).toBeTruthy();
  });

  test("renders five squares plus a +36 tile for forty-one attachments", () => {
    const { container, getByText } = render(
      <MessageAttachments
        attachments={makeImageAttachments(41)}
        messageId="msg-1"
      />,
    );

    expect(squareLabels(container)).toHaveLength(5);
    expect(getByText("+36")).toBeTruthy();
  });

  test("counts non-media attachments toward the limit and keeps source order", () => {
    const images = makeImageAttachments(5);
    const mixed: DisplayAttachment[] = [
      images[0]!,
      makeDisplayAttachment({
        id: "deck-1",
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: 4_096,
      }),
      images[1]!,
      makeDisplayAttachment({
        id: "report-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2_048,
      }),
      makeDisplayAttachment({
        id: "bundle-1",
        filename: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 8_192,
      }),
      images[2]!,
      images[3]!,
      images[4]!,
    ];

    const { container, getByText } = render(
      <MessageAttachments attachments={mixed} messageId="msg-1" />,
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

  test("a visible square opens the preview with every attachment as siblings", () => {
    const { getByLabelText, getByTestId } = render(
      <MessageAttachments
        attachments={makeImageAttachments(8)}
        messageId="msg-1"
      />,
    );

    fireEvent.click(getByLabelText("photo-0.png"));

    const modal = getByTestId("preview-modal");
    expect(modal.getAttribute("data-attachment-id")).toBe("img-0");
    // Gallery navigation spans the whole set, not just the visible squares.
    expect(modal.getAttribute("data-sibling-count")).toBe("8");
    // Opening a preview must not open the files panel.
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("the overflow tile opens the files panel with every attachment", () => {
    const { getByRole, queryByTestId } = render(
      <MessageAttachments
        attachments={makeImageAttachments(8)}
        messageId="msg-1"
      />,
    );

    fireEvent.click(getByRole("button", { name: "Show all files (3 more)" }));

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("message-files");
    expect(viewer.activeMessageFiles?.messageId).toBe("msg-1");
    expect(viewer.activeMessageFiles?.attachments).toHaveLength(8);
    // The tile targets the panel, so the preview modal stays shut.
    expect(queryByTestId("preview-modal")).toBeNull();
  });

  test("the overflow tile reports its expanded state", () => {
    const { getByRole } = render(
      <MessageAttachments
        attachments={makeImageAttachments(8)}
        messageId="msg-1"
      />,
    );

    const tile = getByRole("button", { name: "Show all files (3 more)" });
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("true");
  });

  test("clicking the overflow tile again closes the files panel", () => {
    const { getByRole } = render(
      <MessageAttachments
        attachments={makeImageAttachments(8)}
        messageId="msg-1"
      />,
    );

    const tile = getByRole("button", { name: "Show all files (3 more)" });
    fireEvent.click(tile);
    fireEvent.click(tile);

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("chat");
    expect(viewer.activeMessageFiles).toBeNull();
  });

  test("returns null for an empty attachments array", () => {
    const { container } = render(
      <MessageAttachments attachments={[]} messageId="msg-1" />,
    );
    expect(container.innerHTML).toBe("");
  });
});
