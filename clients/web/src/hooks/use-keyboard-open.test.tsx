/**
 * Tests for `useSoftKeyboardOpen` and `useKeyboardOpen`, the two shared
 * soft-keyboard-visibility booleans.
 *
 * They compose `useIsMobile` + `useVisibleViewport`; both are mocked so each
 * test drives an explicit platform / viewport state.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { VisibleViewport } from "@/hooks/use-visible-viewport";

let isMobile = false;
let visibleViewport: VisibleViewport | null = null;

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobile,
}));
mock.module("@/hooks/use-visible-viewport", () => ({
  KEYBOARD_OPEN_THRESHOLD_PX: 100,
  useVisibleViewport: () => visibleViewport,
}));

const { useKeyboardOpen, useSoftKeyboardOpen } =
  await import("@/hooks/use-keyboard-open");

function viewportWithKeyboard(keyboardHeight: number): VisibleViewport {
  return {
    height: 800 - keyboardHeight,
    keyboardHeight,
    offsetTop: 0,
    offsetLeft: 0,
  };
}

function capture(hook: () => boolean): boolean {
  let captured = false;
  function Probe() {
    captured = hook();
    return null;
  }
  render(<Probe />);
  return captured;
}

function captureKeyboardOpen(): boolean {
  return capture(useKeyboardOpen);
}

function captureSoftKeyboardOpen(): boolean {
  return capture(useSoftKeyboardOpen);
}

afterEach(cleanup);

describe("useKeyboardOpen", () => {
  test("false on desktop regardless of the reported keyboard height", () => {
    isMobile = false;
    visibleViewport = viewportWithKeyboard(300);

    expect(captureKeyboardOpen()).toBe(false);
  });

  test("false on mobile while the viewport is unmeasured (null)", () => {
    isMobile = true;
    visibleViewport = null;

    expect(captureKeyboardOpen()).toBe(false);
  });

  test("false on mobile at exactly the threshold height", () => {
    isMobile = true;
    visibleViewport = viewportWithKeyboard(100);

    expect(captureKeyboardOpen()).toBe(false);
  });

  test("true on mobile above the threshold height", () => {
    isMobile = true;
    visibleViewport = viewportWithKeyboard(300);

    expect(captureKeyboardOpen()).toBe(true);
  });
});

describe("useSoftKeyboardOpen", () => {
  test("ignores viewport width, so a tablet keyboard still reads as open", () => {
    // An iPad in landscape is far above the mobile breakpoint and still
    // raises a soft keyboard. This is what the swipe-down dismiss gesture
    // arms on.
    isMobile = false;
    visibleViewport = viewportWithKeyboard(300);

    expect(captureSoftKeyboardOpen()).toBe(true);
  });

  test("false while the viewport is unmeasured (null)", () => {
    isMobile = false;
    visibleViewport = null;

    expect(captureSoftKeyboardOpen()).toBe(false);
  });

  test("false at exactly the threshold height", () => {
    isMobile = true;
    visibleViewport = viewportWithKeyboard(100);

    expect(captureSoftKeyboardOpen()).toBe(false);
  });
});
