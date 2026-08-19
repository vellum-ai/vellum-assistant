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
