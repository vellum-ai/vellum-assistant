/**
 * Tests for `useKeyboardOpen`, the shared soft-keyboard-visibility boolean.
 *
 * The hook composes `useIsMobile` + `useVisibleViewport`; both are mocked so
 * each test drives an explicit platform / viewport state.
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

const { useKeyboardOpen } = await import("@/hooks/use-keyboard-open");

function viewportWithKeyboard(keyboardHeight: number): VisibleViewport {
  return {
    height: 800 - keyboardHeight,
    keyboardHeight,
    offsetTop: 0,
    offsetLeft: 0,
  };
}

function captureKeyboardOpen(): boolean {
  let captured = false;
  function Probe() {
    captured = useKeyboardOpen();
    return null;
  }
  render(<Probe />);
  return captured;
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
