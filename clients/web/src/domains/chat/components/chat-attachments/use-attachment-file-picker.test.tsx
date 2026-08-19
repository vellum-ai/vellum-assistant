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
// Whether a text entry held focus when the picker opened, which is what says
// there is a keyboard to put back. Stubbed rather than driven through real
// focus so each case states its own answer.
let textEntryFocused = false;
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: requestComposerFocusMock,
  isTextEntryFocused: () => textEntryFocused,
}));

// The dismissal WebKit is going to perform anyway, brought forward to the tap.
const hideNativeKeyboardMock = mock(async () => {});
mock.module("@/runtime/native-keyboard", () => ({
  hideNativeKeyboard: hideNativeKeyboardMock,
}));

// The native shell, where `cancel` is guaranteed and the window-focus fallback
// is not armed. Defaults to the browser, so the existing cases keep it.
let nativeIOS = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => nativeIOS,
}));

// A phone versus a pointing device. Defaults to a mouse, which is always owed
// its caret back, so the cases predating the focus gate stay as they were.
let pointerCoarse = false;
mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => pointerCoarse,
}));

// The shell is held at the keyboard's size for as long as the picker is up.
// Stubbed to a counter so the arm/release pairing is assertable without a
// layout the test environment does not have.
const releaseViewportHoldMock = mock(() => {});
const holdVisibleViewportMock = mock(() => releaseViewportHoldMock);
mock.module("@/hooks/use-visible-viewport", () => ({
  holdVisibleViewport: holdVisibleViewportMock,
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
  hideNativeKeyboardMock.mockClear();
  holdVisibleViewportMock.mockClear();
  releaseViewportHoldMock.mockClear();
  textEntryFocused = false;
  nativeIOS = false;
  pointerCoarse = false;
});

function PickerProbe(props: {
  onFiles: (files: FileList) => void;
  alwaysRestoreFocus?: boolean;
  multiple?: boolean;
  accept?: string;
  capture?: boolean | "user" | "environment";
}) {
  const { openPicker, inputNode, pickerOpen } = useAttachmentFilePicker(props);
  return (
    <>
      {inputNode}
      <span data-testid="picker-open">{String(pickerOpen)}</span>
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
  const openState = () =>
    result.container.querySelector('[data-testid="picker-open"]')?.textContent;
  return { ...result, input, open, openState };
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

  test("holds the shell's size across the picker, and gives it back after", () => {
    // GIVEN a picker opened from a composer the keyboard is up for
    const { input, open } = renderPicker({ onFiles: () => {} });
    open();

    // THEN the shell is pinned before the click that dismisses the keyboard,
    // so it is taken at the size the keyboard left
    expect(holdVisibleViewportMock).toHaveBeenCalledTimes(1);
    expect(releaseViewportHoldMock).not.toHaveBeenCalled();

    // WHEN the picker closes
    fireEvent(input, new Event("cancel"));

    // THEN the shell follows the measurement again, with the composer's focus
    // already requested so the keyboard is on its way back
    expect(releaseViewportHoldMock).toHaveBeenCalledTimes(1);
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("a picker unmounted mid-session still gives the shell back", () => {
    // GIVEN an open picker
    const { open, unmount } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN its owner unmounts before the picker closes, the way a navigation
    // mid-pick would take it
    unmount();

    // THEN the hold goes with it, rather than stranding the shell at a size
    // the keyboard no longer explains
    expect(releaseViewportHoldMock).toHaveBeenCalledTimes(1);
  });

  test("reports the picker open from the click until it closes", () => {
    // GIVEN a probe surfacing the flag the composer gates its layout on
    const { input, open, openState } = renderPicker({ onFiles: () => {} });
    expect(openState()).toBe("false");

    // WHEN the picker is opened
    open();

    // THEN it reads open, so a caller whose own focus the picker just took can
    // still tell the composer is in use
    expect(openState()).toBe("true");

    // AND it closes with the picker, alongside the refocus
    fireEvent(input, new Event("cancel"));
    expect(openState()).toBe("false");
  });

  test("a delivered selection closes it too", () => {
    // GIVEN an open picker
    const { input, open, openState } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN it returns a file rather than being dismissed
    selectFile(input);

    // THEN the flag follows that path out as well
    expect(openState()).toBe("false");
  });

  test("a phone picker opened from a resting composer restores nothing", () => {
    // GIVEN a phone whose composer was not focused when the plus was pressed,
    // so no keyboard was taken and none is owed
    pointerCoarse = true;
    textEntryFocused = false;
    const { input, open } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN the picker is dismissed
    fireEvent(input, new Event("cancel"));

    // THEN the composer is left alone. Focusing it here would summon a
    // keyboard the user never asked for, which the shell allows without a
    // gesture.
    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  test("a phone picker opened from a focused composer restores it", () => {
    // GIVEN a phone whose composer held the keyboard when the plus was pressed
    pointerCoarse = true;
    textEntryFocused = true;
    const { input, open } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN the picker is dismissed
    fireEvent(input, new Event("cancel"));

    // THEN the keyboard the picker took comes back
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("a pointing device is always owed its caret back", () => {
    // GIVEN a desktop picker, where the button itself takes the focus on the
    // way in so nothing reads as focused
    pointerCoarse = false;
    textEntryFocused = false;
    const { input, open } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN a file is picked
    selectFile(input);

    // THEN the caret returns to the composer, as it always has
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("alwaysRestoreFocus overrides the sample for a caller that traps focus", () => {
    // GIVEN the add-to-chat sheet's case: a phone, and a sheet holding focus
    // by the time its row launches the picker
    pointerCoarse = true;
    textEntryFocused = false;
    const { input, open } = renderPicker({
      onFiles: () => {},
      alwaysRestoreFocus: true,
    });
    open();

    // WHEN the picker closes
    fireEvent(input, new Event("cancel"));

    // THEN the keyboard still returns, the way it does today
    expect(requestComposerFocusMock).toHaveBeenCalledTimes(1);
  });

  test("the native shell leaves the window-focus fallback unarmed", () => {
    // GIVEN the iOS shell, which builds against an OS whose WKWebView always
    // fires `cancel`
    nativeIOS = true;
    pointerCoarse = true;
    textEntryFocused = true;
    const { open } = renderPicker({ onFiles: () => {} });
    open();

    // WHEN the app is merely foregrounded, with the picker still on screen
    fireEvent(window, new Event("focus"));

    // THEN nothing treats that as the picker closing
    expect(requestComposerFocusMock).not.toHaveBeenCalled();
  });

  test("the picker asks the keyboard to go before it opens", () => {
    // GIVEN any picker
    const { open } = renderPicker({ onFiles: () => {} });

    // WHEN it opens
    open();

    // THEN the dismissal starts with the tap rather than landing a beat later
    // out of the picker's own presentation animation
    expect(hideNativeKeyboardMock).toHaveBeenCalledTimes(1);
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
