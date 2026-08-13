/**
 * Tests for the mobile "Add to chat" bottom sheet.
 *
 * Mounted with `@testing-library/react` (happy-dom, see
 * `clients/web/test-setup.ts`). The real Radix `BottomSheet` only mounts its
 * content while open and renders it into a portal, so the design-library
 * surface is mocked to render inline: the rows are always in the DOM and
 * clickable, and the mocked `Content` carries a testid so a test can assert
 * the hidden file inputs sit OUTSIDE it.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);

mock.module("@vellumai/design-library", () => ({
  BottomSheet: {
    Root: ({
      children,
      open: _open,
      onOpenChange: _onOpenChange,
      ...props
    }: Record<string, unknown>) =>
      createElement("div", props, children as ReactNode),
    Content: ({
      children,
      padded: _padded,
      ...props
    }: Record<string, unknown>) =>
      createElement(
        "div",
        { "data-testid": "sheet-content", ...props },
        children as ReactNode,
      ),
    Header: passthrough,
    Title: passthrough,
    Body: passthrough,
    Close: ({ children, ...props }: Record<string, unknown>) =>
      createElement(
        "button",
        { type: "button", ...props },
        children as ReactNode,
      ),
  },
}));

import { selectFiles } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import { AddToChatSheet } from "@/domains/chat/components/chat-composer/add-to-chat-sheet";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});

function renderSheet(
  props: Partial<Parameters<typeof AddToChatSheet>[0]> = {},
) {
  const onOpenChange = mock((_open: boolean) => {});
  const onAttachFiles = mock((_files: FileList) => {});
  const result = render(
    <AddToChatSheet
      open
      onOpenChange={onOpenChange}
      onAttachFiles={onAttachFiles}
      {...props}
    />,
  );
  const inputs = Array.from(
    result.container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  );
  const [camera, gallery, files] = inputs;
  return { ...result, onOpenChange, onAttachFiles, camera, gallery, files };
}

describe("AddToChatSheet", () => {
  test("renders the three attach rows", () => {
    renderSheet();

    expect(screen.getByText("Camera")).toBeTruthy();
    expect(screen.getByText("Find in Gallery")).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });

  test("keeps the hidden inputs outside the sheet content", () => {
    renderSheet();

    // The inputs must survive the sheet content unmounting while the native
    // picker is still up, so they cannot live inside the dialog.
    const inside = screen
      .getByTestId("sheet-content")
      .querySelectorAll('input[type="file"]');
    expect(inside.length).toBe(0);
  });

  test("tapping Files closes the sheet and opens its picker", () => {
    const { onOpenChange, files } = renderSheet();
    const clicked = mock(() => {});
    files.addEventListener("click", clicked);

    fireEvent.click(screen.getByText("Files"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test("delivers picked files to onAttachFiles", () => {
    const { onAttachFiles, gallery } = renderSheet();
    const file = new File(["hi"], "photo.png", { type: "image/png" });

    const picked = selectFiles(gallery, [file]);

    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onAttachFiles.mock.calls[0]?.[0]).toBe(picked);
  });

  test("camera input asks for the rear camera and images only", () => {
    const { camera } = renderSheet();

    expect(camera.getAttribute("accept")).toBe("image/*");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.multiple).toBe(false);
  });

  test("gallery input takes multiple images, files input mirrors the paperclip", () => {
    const { gallery, files } = renderSheet();

    expect(gallery.getAttribute("accept")).toBe("image/*,video/*");
    expect(gallery.hasAttribute("capture")).toBe(false);
    expect(gallery.multiple).toBe(true);

    expect(files.hasAttribute("accept")).toBe(false);
    expect(files.hasAttribute("capture")).toBe(false);
    expect(files.multiple).toBe(true);
  });
});
