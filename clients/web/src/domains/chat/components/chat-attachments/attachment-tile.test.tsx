/**
 * Tests for the mobile composer's attachment tile.
 *
 * Mounted with `@testing-library/react` (happy-dom, see
 * `clients/web/test-setup.ts`), against the real design-library `Button` and
 * the real English catalog, so the accessible names asserted here are the ones
 * a screen reader gets.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AttachmentTile } from "@/domains/chat/components/chat-attachments/attachment-tile";

afterEach(() => {
  cleanup();
});

const PREVIEW_URL = "blob:http://localhost:3000/photo";

function renderTile(props: Partial<Parameters<typeof AttachmentTile>[0]> = {}) {
  const onRemove = mock((_id: string) => {});
  const onPreview = mock(() => {});
  const onPreviewError = mock(() => {});
  render(
    <AttachmentTile
      id="att-1"
      filename="photo.jpg"
      previewUrl={PREVIEW_URL}
      onRemove={onRemove}
      onPreview={onPreview}
      onPreviewError={onPreviewError}
      {...props}
    />,
  );
  return { onRemove, onPreview, onPreviewError };
}

describe("AttachmentTile", () => {
  test("shows the uploaded image and no caption", () => {
    const { onRemove, onPreview } = renderTile();

    const preview = screen.getByRole("button", { name: "Preview photo.jpg" });
    const image = preview.querySelector("img");
    expect(image?.getAttribute("src")).toBe(PREVIEW_URL);

    fireEvent.click(preview);
    expect(onPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove photo.jpg" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("att-1");

    // The filename reaches the user through the tooltip and the accessible
    // names only. The tile carries no caption.
    expect(screen.queryByText("photo.jpg")).toBeNull();
  });

  test("shows a spinner face while the upload is in flight", () => {
    const { onRemove } = renderTile({ previewUrl: null });

    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("img", { name: "Uploading photo.jpg" }),
    ).toBeTruthy();

    // The control cancels the upload rather than removing a finished
    // attachment, and says so.
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel upload of photo.jpg" }),
    );
    expect(onRemove).toHaveBeenCalledWith("att-1");
  });

  test("reports a preview the browser cannot decode", () => {
    const { onPreviewError } = renderTile();

    const image = screen
      .getByRole("button", { name: "Preview photo.jpg" })
      .querySelector("img");
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);
    expect(onPreviewError).toHaveBeenCalledTimes(1);
  });

  test("routes the composer's press guard to both controls", () => {
    const pressGuard = mock(() => {});
    renderTile({ pressGuard });

    // The guard cancels the mousedown so a tap on the tile does not blur the
    // textarea and collapse the mobile row out from under the finger.
    fireEvent.mouseDown(
      screen.getByRole("button", { name: "Remove photo.jpg" }),
    );
    expect(pressGuard).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(
      screen.getByRole("button", { name: "Preview photo.jpg" }),
    );
    expect(pressGuard).toHaveBeenCalledTimes(2);
  });
});
