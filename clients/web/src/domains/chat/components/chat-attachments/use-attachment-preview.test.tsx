import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";

import type { DisplayAttachment } from "@/types/attachment-types";

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-preview-modal",
  () => ({
    AttachmentPreviewModal: ({
      attachment,
      currentIndex,
      onClose,
      onNavigate,
      siblingAttachments,
    }: {
      attachment: DisplayAttachment;
      currentIndex?: number;
      onClose: () => void;
      onNavigate?: (attachment: DisplayAttachment, index: number) => void;
      siblingAttachments?: DisplayAttachment[];
    }) => (
      <div role="dialog" data-id={attachment.id} data-index={currentIndex}>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
        <button
          type="button"
          onClick={() =>
            siblingAttachments?.[1] && onNavigate?.(siblingAttachments[1], 1)
          }
        >
          Next
        </button>
      </div>
    ),
  }),
);

const { useAttachmentPreview } =
  await import("@/domains/chat/components/chat-attachments/use-attachment-preview");

afterEach(cleanup);

function attachment(id: string): DisplayAttachment {
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: null,
  };
}

function Harness({
  attachments,
  keys,
  scopeKey,
  showTriggers = true,
}: {
  attachments: DisplayAttachment[];
  keys: string[];
  scopeKey: string;
  showTriggers?: boolean;
}) {
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const { openPreview, previewModal } = useAttachmentPreview(
    "asst-1",
    attachments,
    keys,
    {
      scopeKey,
      getFallbackFocus: () => fallbackRef.current,
    },
  );
  return (
    <>
      <button ref={fallbackRef} type="button">
        Panel control
      </button>
      {showTriggers &&
        attachments.map((item, index) => (
          <button
            key={keys[index]}
            type="button"
            onClick={(event) => openPreview(item, index, event.currentTarget)}
          >
            Open {keys[index]}
          </button>
        ))}
      {previewModal}
    </>
  );
}

describe("useAttachmentPreview keyed selection", () => {
  test("retains the selected occurrence across attachment-id replacement", () => {
    const { getByRole, rerender } = render(
      <Harness
        attachments={[attachment("inline-a"), attachment("inline-b")]}
        keys={["tc-a", "tc-b"]}
        scopeKey="message:block"
      />,
    );
    fireEvent.click(getByRole("button", { name: "Open tc-b" }));
    expect(getByRole("dialog").getAttribute("data-id")).toBe("inline-b");

    rerender(
      <Harness
        attachments={[attachment("att-a"), attachment("att-b")]}
        keys={["tc-a", "tc-b"]}
        scopeKey="message:block"
      />,
    );
    expect(getByRole("dialog").getAttribute("data-id")).toBe("att-b");
    expect(getByRole("dialog").getAttribute("data-index")).toBe("1");
  });

  test("gallery navigation preserves the opening trigger for close focus", async () => {
    const { getByRole } = render(
      <Harness
        attachments={[attachment("att-a"), attachment("att-b")]}
        keys={["tc-a", "tc-b"]}
        scopeKey="message:block"
      />,
    );
    const trigger = getByRole("button", { name: "Open tc-a" });
    fireEvent.click(trigger);
    fireEvent.click(getByRole("button", { name: "Next" }));
    fireEvent.click(getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("falls back to a remaining panel control when the trigger disappears", async () => {
    const { getByRole, rerender } = render(
      <Harness
        attachments={[attachment("att-a")]}
        keys={["tc-a"]}
        scopeKey="message:block"
      />,
    );
    fireEvent.click(getByRole("button", { name: "Open tc-a" }));
    rerender(
      <Harness
        attachments={[attachment("att-a")]}
        keys={["tc-a"]}
        scopeKey="message:block"
        showTriggers={false}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        getByRole("button", { name: "Panel control" }),
      ),
    );
  });

  test("changing panel scope closes the prior preview", () => {
    const { getByRole, queryByRole, rerender } = render(
      <Harness
        attachments={[attachment("att-a")]}
        keys={["tc-a"]}
        scopeKey="message:block-a"
      />,
    );
    fireEvent.click(getByRole("button", { name: "Open tc-a" }));
    expect(getByRole("dialog")).toBeTruthy();
    rerender(
      <Harness
        attachments={[attachment("att-a")]}
        keys={["tc-a"]}
        scopeKey="message:block-b"
      />,
    );
    expect(queryByRole("dialog")).toBeNull();
  });
});
