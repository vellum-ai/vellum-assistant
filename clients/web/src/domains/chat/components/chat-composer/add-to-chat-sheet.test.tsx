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

// A shell that can actually reach the native pickers: both a Capacitor
// runtime AND a build that linked the plugin. Defaults to false, so every
// existing case still exercises the file input.
let mockNativePickersAvailable = false;
type PickOutcome = { skipped: string[] };
type OnPickedFile = (file: File) => void;
const EMPTY_PICK: PickOutcome = { skipped: [] };
let mockPickMedia: (onFile: OnPickedFile) => Promise<PickOutcome> = async () =>
  EMPTY_PICK;
let mockPickFiles: (onFile: OnPickedFile) => Promise<PickOutcome> = async () =>
  EMPTY_PICK;
mock.module(
  "@/domains/chat/components/chat-attachments/native-attachment-pickers",
  () => ({
    nativeAttachmentPickersAvailable: () => mockNativePickersAvailable,
    pickMediaNative: (onFile: OnPickedFile) => mockPickMedia(onFile),
    pickFilesNative: (onFile: OnPickedFile) => mockPickFiles(onFile),
    // The real discriminator, not a stub: what counts as a dismissal is the
    // behaviour under test here.
    isPickerDismissal: (error: unknown) =>
      error instanceof Error && /cancell?ed/i.test(error.message),
  }),
);

const captureErrorSpy = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorSpy,
}));

const requestComposerFocusSpy = mock(() => {});
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: requestComposerFocusSpy,
}));

import { selectFiles } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import { AddToChatSheet } from "@/domains/chat/components/chat-composer/add-to-chat-sheet";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
  mockNativePickersAvailable = false;
  mockPickMedia = async () => EMPTY_PICK;
  mockPickFiles = async () => EMPTY_PICK;
  requestComposerFocusSpy.mockClear();
  captureErrorSpy.mockClear();
});

function renderSheet(
  props: Partial<Parameters<typeof AddToChatSheet>[0]> = {},
) {
  const onOpenChange = mock((_open: boolean) => {});
  const onAttachFiles = mock((_files: FileList | File[]) => {});
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
    expect(screen.getByText("Photo Library")).toBeTruthy();
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

// ---------------------------------------------------------------------------
// The Capacitor shells, where a file input cannot reach either surface
// ---------------------------------------------------------------------------

describe("AddToChatSheet: native pickers", () => {
  test("the photo row opens the photo library and attaches what it returns", async () => {
    // GIVEN a shell whose photo library hands back one image
    mockNativePickersAvailable = true;
    const picked = new File(["x"], "photo-1.jpg", { type: "image/jpeg" });
    mockPickMedia = async (onFile) => {
      onFile(picked);
      return { skipped: [] };
    };
    const { onAttachFiles } = renderSheet();

    // WHEN the photo row is tapped
    fireEvent.click(screen.getByText("Photo Library"));
    await Promise.resolve();
    await Promise.resolve();

    // THEN the file reaches the composer as a plain File[], the shape
    // drag-and-drop already hands down, so it picks up the same vision gating,
    // resize and HEIC conversion a dropped file does
    expect(onAttachFiles).toHaveBeenCalledWith([picked]);
  });

  test("a cancelled pick still hands focus back to the composer", async () => {
    // GIVEN a shell whose picker rejects, which is how both plugins report a
    // dismissal
    mockNativePickersAvailable = true;
    mockPickFiles = async () => {
      throw new Error("User cancelled");
    };
    const { onAttachFiles } = renderSheet();

    // WHEN the files row is tapped and dismissed
    fireEvent.click(screen.getByText("Files"));
    await Promise.resolve();
    await Promise.resolve();

    // THEN nothing is attached
    expect(onAttachFiles).not.toHaveBeenCalled();

    // AND the composer is refocused anyway. The native pickers fire none of
    // the input events `useAttachmentFilePicker` restores focus from, so
    // without this the picker would work and the keyboard would not return.
    expect(requestComposerFocusSpy).toHaveBeenCalled();

    // AND nothing is reported: closing a sheet you opened is not a fault.
    expect(captureErrorSpy).not.toHaveBeenCalled();
  });

  test("a failed pick is reported rather than read as a dismissal", async () => {
    // GIVEN a picker that fails for a real reason, which on iOS covers a
    // temporary-copy or unsupported-type error and here stands for any of them
    mockNativePickersAvailable = true;
    mockPickFiles = async () => {
      throw new Error("Unable to copy file to temporary directory");
    };
    const { onAttachFiles } = renderSheet();

    // WHEN the files row is tapped
    fireEvent.click(screen.getByText("Files"));
    await Promise.resolve();
    await Promise.resolve();

    // THEN nothing is attached, which on its own looks exactly like picking
    // nothing, so the failure is reported instead of vanishing
    expect(onAttachFiles).not.toHaveBeenCalled();
    expect(captureErrorSpy).toHaveBeenCalled();

    // AND focus still returns, the same as any other way out of the picker
    expect(requestComposerFocusSpy).toHaveBeenCalled();
  });

  test("a shell without the plugin keeps the file input on both rows", async () => {
    // GIVEN a build that predates the plugin being linked, which is what a
    // remotely served bundle reaches on an app the user has not updated
    mockNativePickersAvailable = false;
    mockPickMedia = async () => {
      throw new Error("pickMedia is not implemented on ios");
    };
    const { container, onOpenChange } = renderSheet();

    // THEN the hidden inputs are still what the rows drive
    expect(container.querySelectorAll('input[type="file"]').length).toBe(3);

    // AND tapping the photo row still opens one, rather than reaching a
    // rejecting native call and silently doing nothing
    fireEvent.click(screen.getByText("Photo Library"));
    await Promise.resolve();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
