/**
 * Tests for `readVisibleViewport` and `useVisibleViewport`, the visual-viewport
 * read and subscription behind the app shell's keyboard-aware sizing.
 *
 * The hook's seam is `subscribeNativeKeyboardHeight`, so that is what is
 * stubbed: the callback it hands over is the only way into the module's
 * anticipation state, which keeps the tests on the production path. The plugin
 * rig those heights come from belongs to `native-keyboard.test.ts`.
 *
 * `referenceInnerHeight` and the orientation are module state, so each test
 * pins `window.innerHeight` and `matchMedia` rather than relying on ordering;
 * anticipation is cleared by the last consumer unmounting, which `cleanup()`
 * does after every test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

let announceKeyboardHeight: ((keyboardHeight: number) => void) | null = null;

const subscribeNativeKeyboardHeight = mock(
  (onHeightChange: (keyboardHeight: number) => void) => {
    announceKeyboardHeight = onHeightChange;
    return () => {
      announceKeyboardHeight = null;
    };
  },
);

mock.module("@/runtime/native-keyboard", () => ({
  subscribeNativeKeyboardHeight,
}));

const { readVisibleViewport, useVisibleViewport } =
  await import("@/hooks/use-visible-viewport");

const REFERENCE_HEIGHT = 800;
const KEYBOARD_HEIGHT = 336;
// Landscape, free of the keyboard and shrunken by it.
const LANDSCAPE_HEIGHT = 390;
const LANDSCAPE_OPEN_HEIGHT = 193;

interface ViewportStub {
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

function stubViewport(overrides: Partial<ViewportStub> = {}): void {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      height: REFERENCE_HEIGHT,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      // Mounting the hook attaches resize/scroll listeners; the tests drive
      // `readVisibleViewport` directly, so these only need to exist.
      addEventListener: () => {},
      removeEventListener: () => {},
      ...overrides,
    },
  });
}

let isPortraitStub = true;

function setInnerHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

/** Announce a keyboard height the way the native shell does. */
function announce(keyboardHeight: number): void {
  act(() => {
    announceKeyboardHeight!(keyboardHeight);
  });
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: isPortraitStub }) as MediaQueryList,
  });
  isPortraitStub = true;
  setInnerHeight(REFERENCE_HEIGHT);
  subscribeNativeKeyboardHeight.mockClear();
  stubViewport();
  // Settle the orientation and `referenceInnerHeight` on the portrait,
  // keyboard-free state.
  readVisibleViewport();
});

afterEach(() => {
  cleanup();
});

describe("readVisibleViewport", () => {
  test("returns null when the VisualViewport API is unavailable", () => {
    // GIVEN a browser without the API
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });

    // WHEN the viewport is read
    // THEN callers get null and fall back to their static sizing
    expect(readVisibleViewport()).toBeNull();
  });

  test("derives the keyboard height from the shrunken visual viewport", () => {
    // GIVEN a visual viewport shrunken by the soft keyboard
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT, offsetTop: 40 });

    // WHEN the viewport is read
    const viewport = readVisibleViewport();

    // THEN the delta against the reference height is the keyboard height
    expect(viewport?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
    expect(viewport?.offsetTop).toBe(40);
  });
});

describe("useVisibleViewport", () => {
  test("sizes for the keyboard the shell announces, then for its dismissal", () => {
    // GIVEN a mounted consumer on the native iOS shell
    const { result } = renderHook(() => useVisibleViewport());

    // WHEN the shell announces the keyboard at the leading edge of its
    // animation, with the web view frame still at full height
    announce(KEYBOARD_HEIGHT);

    // THEN the hook already reports the keyboard the user can see
    expect(result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(result.current?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
    expect(result.current?.offsetTop).toBe(0);

    // AND the dismissal restores the full viewport
    announce(0);
    expect(result.current?.keyboardHeight).toBe(0);
    expect(result.current?.height).toBe(REFERENCE_HEIGHT);
  });

  test("holds anticipation through a sub-pixel viewport mismatch", () => {
    // GIVEN a visual viewport already reporting a fraction of a pixel below the
    // integer `window.innerHeight`, as WebKit routinely does
    stubViewport({ height: REFERENCE_HEIGHT - 0.5 });
    renderHook(() => useVisibleViewport());

    // WHEN the keyboard is announced against it
    announce(KEYBOARD_HEIGHT);

    // THEN that standing delta is not mistaken for the deferred resize landing,
    // which would retire anticipation inside the announcement that opened it
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
  });

  test("anticipates a taller keyboard while the keyboard is already open", () => {
    // GIVEN a keyboard whose deferred resize has landed
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // WHEN it grows, as it does for the emoji picker, the predictive bar, or a
    // language switch, and the shell re-announces
    const tallerHeight = KEYBOARD_HEIGHT + 84;
    announce(tallerHeight);

    // THEN the new height is anticipated too, rather than layout sitting on the
    // old one until the second deferred resize lands
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(tallerHeight);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT - tallerHeight);
  });

  test("never anticipates past the frame the viewport is currently measured in", () => {
    // GIVEN a tall keyboard whose deferred resize has landed
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // WHEN it shrinks, as the predictive bar closing or a numeric pad taking
    // focus does, and the shell re-announces while the frame is still sized for
    // the tall one
    const shorterHeight = KEYBOARD_HEIGHT - 86;
    announce(shorterHeight);

    // THEN the shell holds the measured height rather than growing past the
    // frame it lives in, which would push the composer below the frame's bottom
    // edge for the whole deferred resize
    const pending = readVisibleViewport();
    expect(pending?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
    expect(pending?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // AND the resize landing is what grows it
    stubViewport({ height: REFERENCE_HEIGHT - shorterHeight });
    const landed = readVisibleViewport();
    expect(landed?.height).toBe(REFERENCE_HEIGHT - shorterHeight);
    expect(landed?.keyboardHeight).toBe(shorterHeight);
  });

  test("retires anticipation when the landed resize is shorter than announced", () => {
    // GIVEN an announced height the native resize never quite reaches, which
    // is what iPad Stage Manager produces: the plugin measures the keyboard's
    // overlap in screen coordinates while the frame shrinks against window
    // bounds
    const landedHeight = KEYBOARD_HEIGHT - 6;
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);

    // WHEN that shorter resize lands
    stubViewport({ height: REFERENCE_HEIGHT - landedHeight });
    const landed = readVisibleViewport();

    // THEN the measurement wins immediately rather than being ignored for the
    // rest of the keyboard session
    expect(landed?.keyboardHeight).toBe(landedHeight);
    expect(landed?.height).toBe(REFERENCE_HEIGHT - landedHeight);

    // AND the restore is measured too
    stubViewport({ height: REFERENCE_HEIGHT });
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("drops an announcement that outlives the reference it was measured against", () => {
    // GIVEN a keyboard open in portrait
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);

    // WHEN the device rotates under it and the shell re-announces against the
    // already-rotated viewport, rebasing the reference on the landscape height
    isPortraitStub = false;
    setInnerHeight(LANDSCAPE_OPEN_HEIGHT);
    stubViewport({ height: LANDSCAPE_OPEN_HEIGHT });
    announce(KEYBOARD_HEIGHT);
    const rotated = readVisibleViewport();
    expect(rotated?.keyboardHeight).toBe(0);
    expect(rotated?.height).toBe(LANDSCAPE_OPEN_HEIGHT);

    // THEN the announcement does not survive that rebase: once the dismissal's
    // window resize lands ahead of the visual viewport, the shell is measured
    // rather than collapsed to `reference - announced`
    setInnerHeight(LANDSCAPE_HEIGHT);
    const restored = readVisibleViewport();
    expect(restored?.height).toBe(LANDSCAPE_OPEN_HEIGHT);
    expect(restored?.keyboardHeight).toBe(
      LANDSCAPE_HEIGHT - LANDSCAPE_OPEN_HEIGHT,
    );
  });

  test("ignores an announced height taller than the reference", () => {
    // GIVEN a reference rebased low by a rotation under an open keyboard
    isPortraitStub = false;
    setInnerHeight(LANDSCAPE_OPEN_HEIGHT);
    stubViewport({ height: LANDSCAPE_OPEN_HEIGHT });
    readVisibleViewport();
    renderHook(() => useVisibleViewport());

    // WHEN a keyboard taller than that reference is announced
    announce(KEYBOARD_HEIGHT);
    const viewport = readVisibleViewport();

    // THEN the measurement stands in, rather than a negative height that CSS
    // would drop and collapse the shell with
    expect(viewport?.height).toBe(LANDSCAPE_OPEN_HEIGHT);
    expect(viewport?.keyboardHeight).toBe(0);
  });

  test("reports no keyboard while pinch-zoomed even with anticipation pending", () => {
    // GIVEN a pinch-zoomed viewport with an anticipated keyboard height
    stubViewport({ height: 600, offsetTop: 30, offsetLeft: 10, scale: 1.5 });
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);

    // WHEN the viewport is read
    const viewport = readVisibleViewport();

    // THEN zoom-induced shrinkage is never mistaken for a keyboard
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(600);
    expect(viewport?.offsetTop).toBe(0);
    expect(viewport?.offsetLeft).toBe(0);
  });

  test("opens one native subscription however many consumers mount", () => {
    // GIVEN two concurrent consumers, as the shell plus a mobile overlay
    const shell = renderHook(() => useVisibleViewport());
    const overlay = renderHook(() => useVisibleViewport());

    // THEN a single subscription covers both
    expect(subscribeNativeKeyboardHeight).toHaveBeenCalledTimes(1);

    // AND both are driven by it
    announce(KEYBOARD_HEIGHT);
    expect(shell.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(overlay.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });

  test("tracks consumers across unmount and remount", () => {
    // GIVEN two concurrent consumers and an open keyboard
    const shell = renderHook(() => useVisibleViewport());
    const overlay = renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);

    // WHEN one of them unmounts with the keyboard genuinely open
    overlay.unmount();

    // THEN the survivor still sizes for the keyboard, with no jump back to the
    // lagging derived measurement
    const stillOpen = readVisibleViewport();
    expect(stillOpen?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(stillOpen?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // AND the last unmount drops anticipation, so a torn-down registry never
    // hands a stale height to whatever mounts next
    shell.unmount();
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);

    // AND a fresh mount re-opens the subscription rather than reusing the
    // closed one
    const remounted = renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);
    expect(remounted.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });
});
