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

import type { AttachmentSquareLabels } from "@/domains/chat/components/chat-attachments/message-attachment-square";
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
function Squares({
  attachments,
  labels,
}: {
  attachments: DisplayAttachment[];
  labels?: AttachmentSquareLabels;
}) {
  const { displayAttachments, renderSquare, previewModal } =
    useAttachmentSquares({ attachments });

  return (
    <>
      {displayAttachments.map((att, index) => renderSquare(att, index, labels))}
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

test("label overrides reach the square without changing attachment actions", () => {
  const { getByRole, getByText, queryByText, getByTestId } = render(
    <Squares
      attachments={[SHARED_ID[0]!]}
      labels={{
        primary: "14:30:05",
        secondary: null,
        title: "Saved 14:30:05",
        ariaLabel: "Saved frame",
      }}
    />,
  );
  const square = getByRole("button", { name: "Saved frame" });
  expect(square.getAttribute("title")).toBe("Saved 14:30:05");
  expect(getByText("14:30:05")).toBeTruthy();
  expect(queryByText("first.pdf")).toBeNull();
  expect(queryByText("1.0 KB")).toBeNull();
  expect(getByRole("button", { name: "Download first.pdf" })).toBeTruthy();
  fireEvent.click(square);
  expect(getByTestId("preview-modal").getAttribute("data-attachment-id")).toBe(
    "rehydrated:0",
  );
});

test("omitting label overrides preserves filename and size defaults", () => {
  const { getByRole, getByText } = render(
    <Squares attachments={[SHARED_ID[0]!]} />,
  );
  expect(getByRole("button", { name: "first.pdf" }).getAttribute("title")).toBe(
    "first.pdf",
  );
  expect(getByText("first.pdf")).toBeTruthy();
  expect(getByText("1.0 KB")).toBeTruthy();
});
