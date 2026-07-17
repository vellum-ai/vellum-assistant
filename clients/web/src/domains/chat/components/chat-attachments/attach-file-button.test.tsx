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

// The attach button re-focuses the composer when the native iOS picker closes
// (both on file-select and on cancel). Mock the focus seam so we can assert the
// request is made without mounting the whole composer/keyboard machinery.
const requestComposerFocusMock = mock(() => {});
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: requestComposerFocusMock,
}));

import { AttachFileButton } from "@/domains/chat/components/chat-attachments/chat-attachments";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  requestComposerFocusMock.mockClear();
});

function makeFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  } as unknown as FileList;
  files.forEach((f, i) => {
    (list as unknown as Record<number, File>)[i] = f;
  });
  return list;
}

describe("AttachFileButton — composer refocus on picker close", () => {
  test("refocuses the composer after a file is selected", () => {
    const onFilesSelected = mock(() => {});
    const { container } = render(
      <AttachFileButton onFilesSelected={onFilesSelected} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    const file = new File(["hi"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: makeFileList([file]),
    });
    fireEvent.change(input);

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    // Keyboard/layout restored after selection.
    expect(requestComposerFocusMock).toHaveBeenCalled();
  });

  test("refocuses the composer when the picker is cancelled (input cancel event)", () => {
    const { container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // A cancel fires no `change`; WebKit dispatches `cancel` on the input when
    // the native picker is dismissed without a selection.
    fireEvent(input, new Event("cancel"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("does not refocus before any picker interaction", () => {
    render(<AttachFileButton onFilesSelected={() => {}} />);
    // Mounting the button alone must not refocus the composer.
    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  test("refocuses via the one-shot window focus fallback (iOS 15–16.3)", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    // Opening the picker arms the fallback; a window focus (web view regains
    // first responder as the picker closes) restores the keyboard on engines
    // that never fire the input `cancel` event.
    fireEvent.click(getByLabelText("Attach file"));
    expect(requestComposerFocusMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // One-shot: a later focus (unrelated) does not refocus again.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("disarms the focus fallback once the picker closes via cancel", () => {
    const { getByLabelText, container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // Open the picker (arms the fallback), then close it via `cancel`.
    fireEvent.click(getByLabelText("Attach file"));
    fireEvent(input, new Event("cancel"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // A later unrelated window focus must NOT refocus — the fallback was
    // disarmed by the cancel path, not left registered.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("disarms the focus fallback once the picker closes via file select", () => {
    const { getByLabelText, container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.click(getByLabelText("Attach file"));
    const file = new File(["hi"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: makeFileList([file]),
    });
    fireEvent.change(input);
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // Fallback disarmed by the change path — a later focus does not refocus.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });
});
