/**
 * Tests for `readVisibleViewport` and `useVisibleViewport`, the visual-viewport
 * read and subscription behind the app shell's keyboard-aware sizing.
 *
 * The read is driven directly against a stubbed `window.visualViewport`, so
 * only the subscription tests mount the hook. `referenceInnerHeight` and the
 * anticipated keyboard height are module state, so each test pins
 * `window.innerHeight` and resets anticipation rather than relying on ordering.
 *
 * The platform gate reports the native iOS shell and `@capacitor/keyboard` is
 * stubbed, so the subscription the hook opens is the real one and the tests
 * that drive it exercise the production wiring end to end.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => true,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

type ShowHandler = (info: { keyboardHeight: number }) => void;
type HideHandler = () => void;

let showHandler: ShowHandler | null = null;
let hideHandler: HideHandler | null = null;

const addListener = mock((eventName: string, handler: unknown) => {
  if (eventName === "keyboardWillShow") {
    showHandler = handler as ShowHandler;
  } else {
    hideHandler = handler as HideHandler;
  }
  return Promise.resolve({
    remove: async () => {
      if (eventName === "keyboardWillShow") {
        showHandler = null;
      } else {
        hideHandler = null;
      }
    },
  });
});

mock.module("@capacitor/keyboard", () => ({
  Keyboard: { addListener },
}));

// Warm the module cache so the lazy `import("@capacitor/keyboard")` inside the
// subscription resolves within microtasks instead of a full loader turn.
await import("@capacitor/keyboard");

const {
  __resetKeyboardAnticipationForTests,
  readVisibleViewport,
  setAnticipatedKeyboardHeight,
  useVisibleViewport,
} = await import("@/hooks/use-visible-viewport");

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

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: isPortraitStub }) as MediaQueryList,
  });
  isPortraitStub = true;
  setInnerHeight(REFERENCE_HEIGHT);
  __resetKeyboardAnticipationForTests();
  showHandler = null;
  hideHandler = null;
  addListener.mockClear();
  stubViewport();
  // Settle the orientation and `referenceInnerHeight` on the portrait,
  // keyboard-free state.
  readVisibleViewport();
});

afterEach(() => {
  cleanup();
  __resetKeyboardAnticipationForTests();
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

  test("retires anticipation when the landed resize is shorter than announced", () => {
    // GIVEN an announced height the native resize never quite reaches, which
    // is what iPad Stage Manager produces: the plugin measures the keyboard's
    // overlap in screen coordinates while the frame shrinks against window
    // bounds
    const landedHeight = KEYBOARD_HEIGHT - 6;
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);

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

  test("drops anticipation when the device rotates under an open keyboard", () => {
    // GIVEN a keyboard announced against the portrait reference height
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);

    // WHEN the device rotates, rebasing the reference on the landscape,
    // keyboard-shrunk `innerHeight`
    isPortraitStub = false;
    setInnerHeight(193);
    stubViewport({ height: 193 });
    const rotated = readVisibleViewport();

    // THEN the stale announcement does not survive its baseline
    expect(rotated?.keyboardHeight).toBe(0);
    expect(rotated?.height).toBe(193);
  });

  test("ignores an announced height taller than the reference", () => {
    // GIVEN a reference rebased low by a rotation under an open keyboard
    isPortraitStub = false;
    setInnerHeight(193);
    stubViewport({ height: 193 });
    readVisibleViewport();

    // WHEN a keyboard taller than that reference is announced
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);
    const viewport = readVisibleViewport();

    // THEN the measurement stands in, rather than a negative height that CSS
    // would drop and collapse the shell with
    expect(viewport?.height).toBe(193);
    expect(viewport?.keyboardHeight).toBe(0);
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

  test("treats a non-positive or non-finite announcement as no keyboard", () => {
    // GIVEN a nonsense height reaching the setter
    for (const nonsense of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      setAnticipatedKeyboardHeight(nonsense);

      // WHEN the viewport is read
      const viewport = readVisibleViewport();

      // THEN it never reaches layout, where it would render as "NaNpx" and
      // fail every comparison that would otherwise retire it
      expect(viewport?.keyboardHeight).toBe(0);
      expect(viewport?.height).toBe(REFERENCE_HEIGHT);
    }
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

describe("useVisibleViewport", () => {
  test("sizes for the keyboard the plugin announces, then for its dismissal", async () => {
    // GIVEN a mounted consumer on the native iOS shell
    const { result } = renderHook(() => useVisibleViewport());
    await flushMicrotasks();

    // WHEN the plugin announces the keyboard at the leading edge of its
    // animation, with the web view frame still at full height
    act(() => {
      showHandler!({ keyboardHeight: KEYBOARD_HEIGHT });
    });

    // THEN the hook already reports the keyboard the user can see
    expect(result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(result.current?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // AND the dismissal restores the full viewport
    act(() => {
      hideHandler!();
    });
    expect(result.current?.keyboardHeight).toBe(0);
    expect(result.current?.height).toBe(REFERENCE_HEIGHT);
  });

  test("opens one native subscription however many consumers mount", async () => {
    // GIVEN two concurrent consumers, as the shell plus a mobile overlay
    const shell = renderHook(() => useVisibleViewport());
    const overlay = renderHook(() => useVisibleViewport());
    await flushMicrotasks();

    // THEN a single pair of plugin listeners covers both
    expect(addListener).toHaveBeenCalledTimes(2);

    // AND both are driven by it
    act(() => {
      showHandler!({ keyboardHeight: KEYBOARD_HEIGHT });
    });
    expect(shell.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(overlay.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });

  test("keeps anticipation while another consumer is still mounted", () => {
    // GIVEN two concurrent consumers and an announced keyboard height
    const shell = renderHook(() => useVisibleViewport());
    const overlay = renderHook(() => useVisibleViewport());
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);

    // WHEN one of them unmounts with the keyboard genuinely open
    overlay.unmount();

    // THEN the survivor still sizes for the keyboard, with no jump back to the
    // lagging derived measurement
    const stillOpen = readVisibleViewport();
    expect(stillOpen?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(stillOpen?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // AND the module drops anticipation with its last consumer, so a torn-down
    // registry never hands a stale height to whatever mounts next
    shell.unmount();
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("survives a mount, unmount, and remount cycle", async () => {
    // GIVEN a consumer that unmounts mid-keyboard
    const first = renderHook(() => useVisibleViewport());
    await flushMicrotasks();
    setAnticipatedKeyboardHeight(KEYBOARD_HEIGHT);
    first.unmount();

    // WHEN the shell remounts without a page reload and the keyboard opens
    // again
    const second = renderHook(() => useVisibleViewport());
    await flushMicrotasks();
    act(() => {
      showHandler!({ keyboardHeight: KEYBOARD_HEIGHT });
    });
    expect(second.result.current?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // THEN the registry is still balanced, so its own unmount clears
    // anticipation
    second.unmount();
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });
});
