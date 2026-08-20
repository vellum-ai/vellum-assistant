/**
 * Tests for `MessageFilesPanel` - the side drawer listing every attachment on
 * one transcript message.
 *
 *  - Renders one square per attachment, media and non-media alike.
 *  - Re-derives from the live transcript when the payload's `messageId`
 *    resolves, and falls back to the open-time snapshot when it does not.
 *  - A resolved message with no attachments renders the empty state rather
 *    than resurrecting the snapshot.
 *  - The header count matches the attachment total.
 *  - The close button fires `onClose`.
 *  - Clicking a square opens the shared preview modal with the whole set as
 *    gallery siblings.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  makeDisplayAttachment,
  makeMixedAttachments,
  mockAttachmentPreviewModal,
  squareLabels,
} from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";

mockAttachmentPreviewModal();

const { MessageFilesPanel } = await import(
  "@/domains/chat/components/message-files-panel"
);

afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

const ATTACHMENTS = makeMixedAttachments();

/** Seed the transcript with one assistant row carrying `attachments`. */
function seedTranscript(
  messageId: string,
  attachments: DisplayAttachment[],
): void {
  const message: DisplayMessage = {
    id: messageId,
    role: "assistant",
    attachments,
  };
  const snapshot: PaginatedHistoryResult = {
    messages: [message],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    seq: 1,
  };
  useChatSessionStore.setState({ snapshot, optimisticSends: [] });
}

function renderPanel(onClose: () => void = () => {}) {
  return render(
    <MessageFilesPanel
      payload={{ messageId: "msg-1", attachments: ATTACHMENTS }}
      onClose={onClose}
    />,
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
    expect(getByText("Files")).toBeTruthy();
    expect(getByText("4")).toBeTruthy();
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

  test("renders the LIVE attachment list when the message resolves", () => {
    seedTranscript("msg-1", [
      ...ATTACHMENTS,
      makeDisplayAttachment({ id: "late-1", filename: "late.png" }),
      makeDisplayAttachment({ id: "late-2", filename: "later.png" }),
    ]);

    const { container, getByText } = renderPanel();

    // Six live attachments beat the four-entry open-time snapshot.
    expect(squareLabels(container)).toHaveLength(6);
    expect(getByText("6")).toBeTruthy();
    expect(squareLabels(container)).toContain("late.png");
  });

  test("falls back to the snapshot when the message id resolves to nothing", () => {
    seedTranscript("other-message", [
      makeDisplayAttachment({ id: "unrelated-1", filename: "unrelated.png" }),
    ]);

    const { container, getByText } = renderPanel();

    expect(squareLabels(container)).toHaveLength(4);
    expect(getByText("4")).toBeTruthy();
    expect(squareLabels(container)).not.toContain("unrelated.png");
  });

  test("a resolved message with no attachments renders the empty state", () => {
    seedTranscript("msg-1", []);

    const { container, getByText } = renderPanel();

    expect(squareLabels(container)).toHaveLength(0);
    expect(getByText("0")).toBeTruthy();
    expect(getByText("No files on this message")).toBeTruthy();
  });
});
