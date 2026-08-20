/**
 * Wiring tests for `useSwipeDownDismissKeyboard`.
 *
 * The gesture's decision logic is covered by the pure-helper tests in
 * `use-swipe-down-dismiss-keyboard.test.ts`. This file covers the one piece
 * that is not pure: which pointer types get `document` listeners, and that a
 * pointer type changing mid-session re-runs setup rather than waiting for the
 * consuming layout to remount.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

let pointerCoarse = true;
mock.module("@/utils/pointer", () => ({
  usePointerCoarse: () => pointerCoarse,
  isPointerCoarse: () => pointerCoarse,
}));

const hideNativeKeyboardMock = mock(async () => {});
mock.module("@/runtime/native-keyboard", () => ({
  hideNativeKeyboard: hideNativeKeyboardMock,
}));

const { useSwipeDownDismissKeyboard } =
  await import("@/hooks/use-swipe-down-dismiss-keyboard");

const TOUCH_EVENTS = ["touchstart", "touchmove", "touchend", "touchcancel"];

let added: string[] = [];
let removed: string[] = [];
const realAdd = document.addEventListener.bind(document);
const realRemove = document.removeEventListener.bind(document);

beforeEach(() => {
  pointerCoarse = true;
  added = [];
  removed = [];
  document.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (TOUCH_EVENTS.includes(type)) {
      added.push(type);
    }
    return (realAdd as unknown as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (TOUCH_EVENTS.includes(type)) {
      removed.push(type);
    }
    return (realRemove as unknown as (...args: unknown[]) => void)(
      type,
      ...rest,
    );
  }) as typeof document.removeEventListener;
});

afterEach(() => {
  document.addEventListener = realAdd;
  document.removeEventListener = realRemove;
});

describe("useSwipeDownDismissKeyboard listener wiring", () => {
  test("attaches the touch listeners on a coarse pointer", () => {
    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });

    expect(added.sort()).toEqual([...TOUCH_EVENTS].sort());
  });

  test("attaches nothing on a fine pointer", () => {
    pointerCoarse = false;

    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });

    expect(added).toEqual([]);
  });

  test("attaches when a device switches to a coarse pointer mid-session", () => {
    // A convertible shedding its keyboard, or a tablet lifted out of a dock.
    // The gesture has to arrive then, not on the next remount of the layout.
    pointerCoarse = false;
    const { rerender } = renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    expect(added).toEqual([]);

    pointerCoarse = true;
    rerender();

    expect(added.sort()).toEqual([...TOUCH_EVENTS].sort());
  });

  test("detaches when a device switches back to a fine pointer", () => {
    const { rerender } = renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    expect(added.sort()).toEqual([...TOUCH_EVENTS].sort());

    pointerCoarse = false;
    rerender();

    expect(removed.sort()).toEqual([...TOUCH_EVENTS].sort());
  });

  test("keeps the listeners installed when only `enabled` changes", () => {
    // Dismissing flips `enabled` false mid-gesture; tearing the listeners down
    // there would strand the in-flight touch.
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useSwipeDownDismissKeyboard({ enabled });
      },
      { initialProps: { enabled: true } },
    );
    expect(added.sort()).toEqual([...TOUCH_EVENTS].sort());

    rerender({ enabled: false });

    expect(removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gesture behaviour against the live DOM. The hook listens on `document`, so
// dispatching a bubbling event from an element reaches it with that element as
// the target, which is what the selectable-text checks read.
// ---------------------------------------------------------------------------

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  touches: FakeTouch[],
): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: touches });
  target.dispatchEvent(event);
}

const realGetSelection = window.getSelection.bind(window);

function stubSelection(collapsed: boolean): void {
  window.getSelection = (() => ({
    isCollapsed: collapsed,
  })) as typeof window.getSelection;
}

describe("useSwipeDownDismissKeyboard selection handling", () => {
  let composer: HTMLTextAreaElement;
  let message: HTMLElement;

  beforeEach(() => {
    stubSelection(true);
    hideNativeKeyboardMock.mockClear();
    composer = document.createElement("textarea");
    message = document.createElement("div");
    message.setAttribute("data-message-text", "");
    document.body.append(composer, message);
  });

  afterEach(() => {
    window.getSelection = realGetSelection;
    composer.remove();
    message.remove();
  });

  function armAndDrag(target: Element): void {
    dispatchTouch(target, "touchstart", [
      { identifier: 1, clientX: 100, clientY: 100 },
    ]);
    dispatchTouch(target, "touchmove", [
      { identifier: 1, clientX: 100, clientY: 200 },
    ]);
  }

  test("dismisses on a swipe over message text with no selection", () => {
    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    composer.focus();

    armAndDrag(message);

    expect(document.activeElement).not.toBe(composer);
  });

  test("does not dismiss when a long press raises a selection mid-drag", () => {
    // The touch begins with nothing selected, so the gesture arms. The long
    // press lands during the drag, and from there the finger is extending a
    // selection, not swiping.
    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    composer.focus();

    dispatchTouch(message, "touchstart", [
      { identifier: 1, clientX: 100, clientY: 100 },
    ]);
    stubSelection(false);
    dispatchTouch(message, "touchmove", [
      { identifier: 1, clientX: 100, clientY: 200 },
    ]);

    expect(document.activeElement).toBe(composer);
    expect(hideNativeKeyboardMock).not.toHaveBeenCalled();
  });

  test("still dismisses when a selection appears under a drag that began off message text", () => {
    // Only the touch that started on message text can be the one adjusting a
    // selection. A swipe on the header is not, however the selection got there.
    const header = document.createElement("header");
    document.body.appendChild(header);
    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    composer.focus();

    dispatchTouch(header, "touchstart", [
      { identifier: 1, clientX: 100, clientY: 100 },
    ]);
    stubSelection(false);
    dispatchTouch(header, "touchmove", [
      { identifier: 1, clientX: 100, clientY: 200 },
    ]);

    expect(document.activeElement).not.toBe(composer);
    header.remove();
  });

  test("never arms on message text that already carries a selection", () => {
    stubSelection(false);
    renderHook(() => {
      useSwipeDownDismissKeyboard({ enabled: true });
    });
    composer.focus();

    armAndDrag(message);

    expect(document.activeElement).toBe(composer);
  });
});
