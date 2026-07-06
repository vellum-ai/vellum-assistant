/**
 * Tests for `useMobileOverlayViewportStyle` — the keyboard-aware positioning
 * style shared by the mobile full-screen overlays.
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

const { useMobileOverlayViewportStyle } = await import(
  "@/hooks/use-mobile-overlay-viewport-style"
);

function captureStyle(): React.CSSProperties {
  let captured: React.CSSProperties = {};
  function Probe() {
    captured = useMobileOverlayViewportStyle();
    return null;
  }
  render(<Probe />);
  return captured;
}

afterEach(cleanup);

describe("useMobileOverlayViewportStyle", () => {
  test("anchors to the full dynamic viewport when the keyboard is closed", () => {
    // GIVEN a mobile viewport with no keyboard open
    isMobile = true;
    visibleViewport = {
      height: 800,
      keyboardHeight: 0,
      offsetTop: 0,
      offsetLeft: 0,
    };

    // WHEN the overlay style is computed
    const style = captureStyle();

    // THEN it fills the viewport bottom-up with safe-area padding
    expect(style.position).toBe("fixed");
    expect(style.bottom).toBe(0);
    expect(style.top).toBe("auto");
    expect(style.height).toBe("100dvh");
    expect(style.paddingBottom).toContain("safe-area-inset-bottom");
  });

  test("tracks the visual viewport when the keyboard is open", () => {
    // GIVEN a mobile viewport with the soft keyboard raised and the page
    // scrolled to reveal the focused input
    isMobile = true;
    visibleViewport = {
      height: 500,
      keyboardHeight: 300,
      offsetTop: 40,
      offsetLeft: 0,
    };

    // WHEN the overlay style is computed
    const style = captureStyle();

    // THEN it is pinned to the visible region above the keyboard, with the
    // bottom safe-area padding dropped (matching RootLayout compensation)
    expect(style.top).toBe("40px");
    expect(style.bottom).toBe("auto");
    expect(style.height).toBe("500px");
    expect(style.paddingBottom).toBe(0);
  });

  test("ignores sub-threshold height deltas as incidental drift", () => {
    // GIVEN a mobile viewport whose height delta is below the keyboard threshold
    isMobile = true;
    visibleViewport = {
      height: 780,
      keyboardHeight: 20,
      offsetTop: 0,
      offsetLeft: 0,
    };

    // WHEN the overlay style is computed
    const style = captureStyle();

    // THEN it stays anchored to the full dynamic viewport
    expect(style.height).toBe("100dvh");
    expect(style.bottom).toBe(0);
  });

  test("does not track the viewport on non-mobile platforms", () => {
    // GIVEN a desktop platform even with a shrunken visual viewport
    isMobile = false;
    visibleViewport = {
      height: 500,
      keyboardHeight: 300,
      offsetTop: 40,
      offsetLeft: 0,
    };

    // WHEN the overlay style is computed
    const style = captureStyle();

    // THEN it uses the static full-height anchoring
    expect(style.height).toBe("100dvh");
    expect(style.top).toBe("auto");
  });
});
