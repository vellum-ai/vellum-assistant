import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

// The picker re-focuses the composer whenever the native iOS picker closes.
// Mock the focus seam so we can assert the request without mounting the whole
// composer/keyboard machinery.
const requestComposerFocusMock = mock(() => {});
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: requestComposerFocusMock,
}));

import { selectFiles } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  requestComposerFocusMock.mockClear();
});

function PickerProbe(props: {
  onFiles: (files: FileList) => void;
  multiple?: boolean;
  accept?: string;
  capture?: boolean | "user" | "environment";
}) {
  const { openPicker, inputNode } = useAttachmentFilePicker(props);
  return (
    <>
      {inputNode}
      <button type="button" onClick={openPicker}>
        open
      </button>
    </>
  );
}

function renderPicker(props: Parameters<typeof PickerProbe>[0]) {
  const result = render(<PickerProbe {...props} />);
  const input = result.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const open = () => fireEvent.click(result.getByText("open"));
  return { ...result, input, open };
}

function selectFile(input: HTMLInputElement, name = "note.txt"): FileList {
  return selectFiles(input, [new File(["hi"], name, { type: "text/plain" })]);
}

describe("useAttachmentFilePicker", () => {
  test("openPicker clicks the hidden input", () => {
    const { input, open } = renderPicker({ onFiles: () => {} });
    const clicked = mock(() => {});
    input.addEventListener("click", clicked);

    open();

    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test("delivers selected files and refocuses the composer", () => {
    const onFiles = mock(() => {});
    const { input } = renderPicker({ onFiles });

    selectFile(input);

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("refocuses without delivering when change carries no files", () => {
    const onFiles = mock(() => {});
    const { input } = renderPicker({ onFiles });

    fireEvent.change(input);

    expect(onFiles).not.toHaveBeenCalled();
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("refocuses when the picker is dismissed (input cancel event)", () => {
    const { input } = renderPicker({ onFiles: () => {} });

    // A dismissal fires no `change`; WebKit dispatches `cancel` on the input.
    fireEvent(input, new Event("cancel"));

    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("refocuses via the one-shot window focus fallback (iOS 15 through 16.3)", () => {
    const { open } = renderPicker({ onFiles: () => {} });

    open();
    expect(requestComposerFocusMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // One-shot: a later unrelated focus does not refocus again.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("disarms the focus fallback once the picker closes", () => {
    const { input, open } = renderPicker({ onFiles: () => {} });

    open();
    selectFile(input);
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("mirrors accept, capture, and multiple onto the input", () => {
    const { input } = renderPicker({
      onFiles: () => {},
      accept: "image/*",
      capture: "environment",
      multiple: true,
    });

    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.multiple).toBe(true);
  });

  test("omits accept and capture and stays single-file by default", () => {
    const { input } = renderPicker({ onFiles: () => {} });

    expect(input.hasAttribute("accept")).toBe(false);
    expect(input.hasAttribute("capture")).toBe(false);
    expect(input.multiple).toBe(false);
  });
});
