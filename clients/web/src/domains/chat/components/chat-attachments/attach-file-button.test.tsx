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

/** All three hidden source inputs, in DOM order: library, camera, files. */
function sourceInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll('input[type="file"]'),
  ) as HTMLInputElement[];
}

function selectFileOn(input: HTMLInputElement, name = "note.txt") {
  const file = new File(["hi"], name, { type: "text/plain" });
  Object.defineProperty(input, "files", {
    configurable: true,
    value: makeFileList([file]),
  });
  fireEvent.change(input);
}

describe("AttachFileButton — source inputs", () => {
  test("renders three hidden inputs: image library, camera capture, unrestricted files", () => {
    const { container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const [library, camera, files] = sourceInputs(container);

    // Photo Library: images only, multi-select, no capture device.
    expect(library.getAttribute("accept")).toBe("image/*");
    expect(library.hasAttribute("multiple")).toBe(true);
    expect(library.hasAttribute("capture")).toBe(false);

    // Take Photo: images only, requests the environment-facing camera.
    expect(camera.getAttribute("accept")).toBe("image/*");
    expect(camera.getAttribute("capture")).toBe("environment");

    // Choose Files: unrestricted, multi-select.
    expect(files.getAttribute("accept")).toBeNull();
    expect(files.hasAttribute("multiple")).toBe(true);
  });

  test("exposes the paperclip trigger with an accessible label", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    expect(getByLabelText("Attach file")).not.toBeNull();
  });
});

describe("AttachFileButton — composer refocus on picker close", () => {
  test("forwards selected files and refocuses the composer, from any source input", () => {
    const onFilesSelected = mock((_files: FileList) => {});
    const { container } = render(
      <AttachFileButton onFilesSelected={onFilesSelected} />,
    );
    // Each of the three inputs must forward files + restore the keyboard, so
    // the behaviour is source-agnostic.
    const inputs = sourceInputs(container);
    expect(inputs).toHaveLength(3);

    for (const input of inputs) {
      onFilesSelected.mockClear();
      requestComposerFocusMock.mockClear();
      selectFileOn(input);
      expect(onFilesSelected).toHaveBeenCalledTimes(1);
      expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
    }
  });

  test("refocuses the composer when the picker is cancelled, from any source input", () => {
    const { container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const inputs = sourceInputs(container);

    for (const input of inputs) {
      requestComposerFocusMock.mockClear();
      // A cancel fires no `change`; WebKit dispatches `cancel` on the input
      // when the native picker is dismissed without a selection.
      fireEvent(input, new Event("cancel"));
      expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
    }
  });

  test("does not refocus before any picker interaction", () => {
    render(<AttachFileButton onFilesSelected={() => {}} />);
    // Mounting the button alone must not refocus the composer.
    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  // Regression guard for the bug this component replaced: a prior version armed
  // a one-shot `window` `focus` listener to refocus on iOS 15–16.3, but that
  // listener fired on *any* window focus (app foregrounding, dismissing an
  // unrelated overlay) and popped the keyboard back up on unrelated taps. The
  // refocus signal must now come only from the file input's own `change`/
  // `cancel` events — never from a bare window focus.
  test("does NOT refocus on a bare window focus (no window-focus fallback)", () => {
    render(<AttachFileButton onFilesSelected={() => {}} />);

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));

    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  test("still does not refocus on window focus after a real picker close", () => {
    const { container } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    const [library] = sourceInputs(container);

    // A real close (file selected) refocuses exactly once...
    selectFileOn(library);
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // ...and a later unrelated window focus must not add a second refocus.
    window.dispatchEvent(new Event("focus"));
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });
});
