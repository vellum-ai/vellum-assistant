/**
 * The square renderer every message-attachment surface shares. A legacy
 * transcript can carry two rows under one synthetic `rehydrated:` id, so a
 * square hands the gallery its own position rather than leaving the modal to
 * resolve an id that names both of them.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { mockAttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";

const restorePreviewModal = mockAttachmentPreviewModal();

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";

// `mock.module` is process-global, so the real preview modal goes back before
// the next file loads.
afterAll(() => {
  restorePreviewModal();
  mock.restore();
});
afterEach(() => {
  cleanup();
});

/** The layout every caller writes for itself, reduced to the squares. */
function Squares({ attachments }: { attachments: DisplayAttachment[] }) {
  const { displayAttachments, renderSquare, previewModal } =
    useAttachmentSquares({ attachments });

  return (
    <>
      {displayAttachments.map((att, index) => renderSquare(att, index))}
      {previewModal}
    </>
  );
}

/** Two rows the text-parsing history fallback rehydrated under one id. */
const SHARED_ID: DisplayAttachment[] = [
  {
    id: "rehydrated:0",
    filename: "first.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1_024,
    previewUrl: null,
  },
  {
    id: "rehydrated:0",
    filename: "second.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_048,
    previewUrl: null,
  },
];

describe("useAttachmentSquares", () => {
  test("opens the gallery at the clicked square's position, not its id", () => {
    const { getByRole, getByTestId } = render(
      <Squares attachments={SHARED_ID} />,
    );

    fireEvent.click(getByRole("button", { name: "second.pdf" }));

    const modal = getByTestId("preview-modal");
    expect(modal.getAttribute("data-attachment-id")).toBe("rehydrated:0");
    expect(modal.getAttribute("data-current-index")).toBe("1");
  });

  test("nulls only the failed position's preview when two squares share an id", () => {
    const withPreview = SHARED_ID.map((att, index) => ({
      ...att,
      mimeType: "image/png",
      filename: `${index}.png`,
      previewUrl: `https://example.com/${index}.png`,
    }));
    const { container } = render(<Squares attachments={withPreview} />);

    const [first] = Array.from(container.querySelectorAll("img"));
    fireEvent.error(first!);

    const remaining = Array.from(container.querySelectorAll("img"));
    expect(remaining.map((img) => img.getAttribute("src"))).toEqual([
      "https://example.com/1.png",
    ]);
  });

  test("keys each square on its position, so a shared id is still unique", () => {
    const logged: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      render(<Squares attachments={SHARED_ID} />);
    } finally {
      console.error = realError;
    }

    expect(logged.map(String).join("\n")).not.toContain("same key");
  });
});
