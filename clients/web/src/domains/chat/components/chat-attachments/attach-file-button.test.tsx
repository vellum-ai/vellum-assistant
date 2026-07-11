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

import { publish } from "@/lib/event-bus";
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

  test("refocuses the composer when the picker is cancelled (app.resume)", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );

    // Tapping the button arms the picker-pending flag and opens the (native)
    // picker. A cancel fires no `change`; the keyboard is restored when the app
    // foregrounds again, delivered as `app.resume` on the event bus.
    fireEvent.click(getByLabelText("Attach file"));
    expect(requestComposerFocusMock).not.toHaveBeenCalled();

    publish("app.resume", { signal: "visibility" });
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);

    // The pending flag is one-shot — a second resume does not refocus again.
    publish("app.resume", { signal: "visibility" });
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("ignores app.resume when no picker is pending", () => {
    render(<AttachFileButton onFilesSelected={() => {}} />);
    // A resume that isn't preceded by a picker open must not refocus.
    publish("app.resume", { signal: "visibility" });
    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  test("ignores network-online resumes even while a picker is pending", () => {
    const { getByLabelText } = render(
      <AttachFileButton onFilesSelected={() => {}} />,
    );
    fireEvent.click(getByLabelText("Attach file"));
    // A network blip resume is not a picker dismissal — do not refocus, and
    // keep the pending flag armed for the real foregrounding resume.
    publish("app.resume", { signal: "online" });
    expect(requestComposerFocusMock).not.toHaveBeenCalled();

    publish("app.resume", { signal: "visibility" });
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });
});
