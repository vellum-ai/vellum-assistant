/**
 * Tests for the composer's attachment chip.
 *
 * Mounted with `@testing-library/react` (happy-dom, see
 * `clients/web/test-setup.ts`) against the real design-library `Button` and the
 * real English catalog.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AttachmentChip } from "@/domains/chat/components/chat-attachments/attachment-chip";

afterEach(() => {
  cleanup();
});

const PREVIEW_URL = "blob:http://localhost:3000/photo";

function renderChip(props: Partial<Parameters<typeof AttachmentChip>[0]> = {}) {
  const onRemove = mock((_id: string) => {});
  const onPreviewError = mock(() => {});
  render(
    <AttachmentChip
      id="att-1"
      filename="photo.jpg"
      mimeType="image/jpeg"
      previewUrl={PREVIEW_URL}
      onRemove={onRemove}
      onPreviewError={onPreviewError}
      {...props}
    />,
  );
  return { onRemove, onPreviewError };
}

describe("AttachmentChip", () => {
  test("reports a preview the browser cannot decode", () => {
    const { onPreviewError } = renderChip();

    const image = screen
      .getByRole("img", { name: "photo.jpg" })
      .querySelector("img");
    expect(image?.getAttribute("src")).toBe(PREVIEW_URL);

    fireEvent.error(image as HTMLImageElement);
    expect(onPreviewError).toHaveBeenCalledTimes(1);
  });

  test("routes the composer's press guard to the remove control", () => {
    const pressGuard = mock(() => {});
    const { onRemove } = renderChip({ pressGuard });

    const remove = screen.getByRole("button", { name: "Remove photo.jpg" });
    fireEvent.mouseDown(remove);
    expect(pressGuard).toHaveBeenCalledTimes(1);

    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("att-1");
  });
});
