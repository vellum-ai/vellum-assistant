/**
 * Tests for the composer's paperclip trigger. The picker mechanics it delegates
 * to (refocus on close, the iOS focus fallback, input attributes) are covered
 * by `use-attachment-file-picker.test.tsx`; what is asserted here is the
 * button's own contract: how it renders, when it is disabled, that it opens the
 * picker, and that it forwards the selection to its callback.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { selectFiles } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import { AttachFileButton } from "@/domains/chat/components/chat-attachments/chat-attachments";

afterEach(() => {
  cleanup();
});

function renderButton(
  props: Partial<Parameters<typeof AttachFileButton>[0]> = {},
) {
  const onFilesSelected = mock((_files: FileList) => {});
  const result = render(
    <AttachFileButton onFilesSelected={onFilesSelected} {...props} />,
  );
  const input = result.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const button = result.getByLabelText("Attach file") as HTMLButtonElement;
  return { ...result, onFilesSelected, input, button };
}

describe("AttachFileButton", () => {
  test("renders an icon trigger over a hidden multi-file input", () => {
    const { button, input } = renderButton();

    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("title")).toBe("Attach file");
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
  });

  test("takes a tooltip override while keeping its accessible name", () => {
    const { button } = renderButton({ title: "Attach to this message" });

    expect(button.getAttribute("title")).toBe("Attach to this message");
    expect(button.getAttribute("aria-label")).toBe("Attach file");
  });

  test("disables the trigger when disabled", () => {
    const { button } = renderButton({ disabled: true });

    expect(button.disabled).toBe(true);
  });

  test("opens the picker on click", () => {
    const { button, input } = renderButton();
    const clicked = mock(() => {});
    input.addEventListener("click", clicked);

    fireEvent.click(button);

    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test("forwards the picked files to onFilesSelected", () => {
    const { input, onFilesSelected } = renderButton();

    const picked = selectFiles(input, [
      new File(["hi"], "note.txt", { type: "text/plain" }),
    ]);

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    expect(onFilesSelected.mock.calls[0]?.[0]).toBe(picked);
  });
});
