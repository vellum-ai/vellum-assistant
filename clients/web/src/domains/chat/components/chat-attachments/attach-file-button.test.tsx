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

  test("refocuses the composer when the picker is cancelled (window regains focus)", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );

    // Tapping the button arms the one-shot focus/visibility listeners and opens
    // the (native) picker. A cancel fires no `change`, only a window `focus`
    // when the web view regains first responder.
    fireEvent.click(getByLabelText("Attach file"));
    expect(requestComposerFocusMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // The listener is one-shot — a second focus event does not refocus again.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("refocuses via visibilitychange when the document becomes visible again", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );

    fireEvent.click(getByLabelText("Attach file"));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });
});
