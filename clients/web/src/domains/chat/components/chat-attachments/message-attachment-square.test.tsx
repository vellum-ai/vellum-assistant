import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { DisplayAttachment } from "@/types/attachment-types";

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));

const { MessageAttachmentSquare } =
  await import("@/domains/chat/components/chat-attachments/message-attachment-square");

afterEach(cleanup);

const IMAGE: DisplayAttachment = {
  id: "att-1",
  filename: "frame.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  previewUrl: "data:image/png;base64,AAAA",
};

describe("MessageAttachmentSquare captions", () => {
  test("keeps both caption rows by default", () => {
    const { getByText } = render(
      <MessageAttachmentSquare attachment={IMAGE} />,
    );

    expect(getByText("frame.png")).toBeTruthy();
    expect(getByText("1.0 KB")).toBeTruthy();
  });

  test("omits caption rows and gap while preserving tile interaction", () => {
    const preview = mock(() => {});
    const { getByRole, queryByText } = render(
      <MessageAttachmentSquare
        attachment={IMAGE}
        hideCaptions
        labels={{ title: "Screenshot", ariaLabel: "Preview screenshot" }}
        onPreview={preview}
      />,
    );

    const tile = getByRole("button", { name: "Preview screenshot" });
    expect(tile.className).not.toContain("gap-1");
    expect(tile.getAttribute("title")).toBe("Screenshot");
    expect(tile.querySelector(".h-16.w-16")).not.toBeNull();
    expect(queryByText("frame.png")).toBeNull();
    expect(queryByText("1.0 KB")).toBeNull();

    fireEvent.click(tile);
    fireEvent.keyDown(tile, { key: "Enter" });
    fireEvent.keyDown(tile, { key: " " });
    expect(preview).toHaveBeenCalledTimes(3);
  });
});
