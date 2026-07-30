/**
 * Tests for `readVisibleViewport`, the visual-viewport read behind the app
 * shell's keyboard-aware sizing.
 *
 * The function is driven directly against a stubbed `window.visualViewport`,
 * so nothing here mounts React. `referenceInnerHeight` and the anticipated
 * keyboard height are module state, so each test pins `window.innerHeight` and
 * resets anticipation rather than relying on ordering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  readVisibleViewport,
  setAnticipatedKeyboardHeight,
} from "@/hooks/use-visible-viewport";

const REFERENCE_HEIGHT = 800;
const KEYBOARD_HEIGHT = 336;

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
      ...overrides,
    },
  });
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: REFERENCE_HEIGHT,
  });
  setAnticipatedKeyboardHeight(0);
  stubViewport();
  // Settle `referenceInnerHeight` on the keyboard-free height.
  readVisibleViewport();
});

afterEach(() => {
  setAnticipatedKeyboardHeight(0);
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

  test("reports the anticipated height before the native resize lands", () => {
    // GIVEN the native shell has announced the keyboard height while the web
    // view frame is still at its full height
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);
    stubViewport({ height: REFERENCE_HEIGHT });

    // WHEN the viewport is read
    const viewport = readVisibleViewport();

    // THEN layout is sized for the keyboard the user can already see
    expect(viewport?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
    expect(viewport?.offsetTop).toBe(0);
  });

  test("hands back to the derived values once the native resize lands", () => {
    // GIVEN an anticipated keyboard height
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);

    // WHEN the web view frame catches up to it
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    const landed = readVisibleViewport();

    // THEN the measured viewport is reported, with no second jump
    expect(landed?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(landed?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // AND anticipation is retired, so a restored viewport reads as keyboard-free
    stubViewport({ height: REFERENCE_HEIGHT });
    const restored = readVisibleViewport();
    expect(restored?.keyboardHeight).toBe(0);
    expect(restored?.height).toBe(REFERENCE_HEIGHT);
  });

  test("returns to the derived path as soon as anticipation is cleared", () => {
    // GIVEN an anticipated keyboard height being reported
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // WHEN the keyboard hides and anticipation is cleared
    setAnticipatedKeyboardHeight(0);

    // THEN the measured viewport drives the restore immediately
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT);
  });

  test("reports no keyboard while pinch-zoomed even with anticipation pending", () => {
    // GIVEN a pinch-zoomed viewport with an anticipated keyboard height
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);
    stubViewport({ height: 600, offsetTop: 30, offsetLeft: 10, scale: 1.5 });

    // WHEN the viewport is read
    const viewport = readVisibleViewport();

    // THEN zoom-induced shrinkage is never mistaken for a keyboard
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(600);
    expect(viewport?.offsetTop).toBe(0);
    expect(viewport?.offsetLeft).toBe(0);
  });
});
