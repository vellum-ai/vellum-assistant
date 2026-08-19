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

let announceKeyboardHeight:
  ((keyboardHeight: number, visible: boolean) => void) | null = null;
// Whether the stubbed shell reports a keyboard source, as one with the plugin
// linked does and one built before it never does.
let stubReportsKeyboardSource = true;
// Held so a test can let registration land after the fact, the way a lazy
// plugin import does.
let reportKeyboardSource: (() => void) | null = null;

const subscribeNativeKeyboardHeight = mock(
  (
    onHeightChange: (keyboardHeight: number) => void,
    onSourceReady?: () => void,
  ) => {
    announceKeyboardHeight = onHeightChange;
    reportKeyboardSource = onSourceReady ?? null;
    if (stubReportsKeyboardSource) {
      onSourceReady?.();
    }
    return () => {
      announceKeyboardHeight = null;
      reportKeyboardSource = null;
    };
  },
);

mock.module("@/runtime/native-keyboard", () => ({
  subscribeNativeKeyboardHeight,
}));

// Whether the stub stands in for a shell whose frame the keyboard resizes. Only
// there is a shrink ambiguous, so only there does the reference wait for an
// announcement before trusting that no keyboard is up.
let stubIsNativeMobile = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeMobile: () => stubIsNativeMobile,
}));

const { holdVisibleViewport, readVisibleViewport, useVisibleViewport } =
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

/**
 * Announce a keyboard height the way the native shell does. Visibility is
 * carried separately from the height, since the bridge sanitizes a malformed
 * show payload to `0` and a keyboard coming up still means one is coming up.
 */
function announce(keyboardHeight: number, visible = keyboardHeight > 0): void {
  act(() => {
    announceKeyboardHeight!(keyboardHeight, visible);
  });
}

beforeEach(() => {
  stubIsNativeMobile = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: isPortraitStub }) as MediaQueryList,
  });
  isPortraitStub = true;
  stubReportsKeyboardSource = true;
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

describe("holdVisibleViewport", () => {
  test("pins the shell at the keyboard's size while a picker is up", () => {
    // GIVEN a keyboard-open viewport, the state the composer is in when the
    // plus is pressed
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT, offsetTop: 40 });
    const release = holdVisibleViewport();

    // WHEN iOS resigns the web view's first responder to present the picker,
    // which dismisses the keyboard and grows the viewport back
    stubViewport({ height: REFERENCE_HEIGHT, offsetTop: 0 });

    // THEN the reading stays where the keyboard left it, so the shell does not
    // walk the composer down the screen behind a picker covering that space
    const held = readVisibleViewport();
    expect(held?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    expect(held?.height).toBe(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);
    expect(held?.offsetTop).toBe(40);

    // AND the release hands the shell back to the measurement
    release();
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
    expect(readVisibleViewport()?.height).toBe(REFERENCE_HEIGHT);
  });

  test("holds nothing when no keyboard was up to collapse", () => {
    // GIVEN a desktop or an unfocused composer, where the picker costs the
    // layout nothing
    stubViewport({ height: REFERENCE_HEIGHT });
    const release = holdVisibleViewport();

    // WHEN the viewport moves for reasons of its own
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });

    // THEN the measurement is still authoritative
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    release();
  });

  test("one picker's release leaves another's hold standing", () => {
    // GIVEN two pickers holding at once, as the composer's plus and the
    // attachments strip each own a session of their own
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    const releaseFirst = holdVisibleViewport();
    const releaseSecond = holdVisibleViewport();
    stubViewport({ height: REFERENCE_HEIGHT });

    // WHEN one of them closes
    releaseFirst();

    // THEN the other still has the shell
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);

    // AND only the last release gives it back
    releaseSecond();
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("a repeated release cannot unbalance the depth", () => {
    // GIVEN a released hold
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    const release = holdVisibleViewport();
    release();

    // WHEN the same release runs again, as a close path and an unmount both
    // reaching for it would
    release();

    // THEN a later hold still works, rather than starting from a negative depth
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    const next = holdVisibleViewport();
    stubViewport({ height: REFERENCE_HEIGHT });
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
    next();
  });

  test("a rotation drops the hold rather than pinning the old orientation", () => {
    // GIVEN a portrait hold taken while the keyboard was up
    stubViewport({ height: REFERENCE_HEIGHT - KEYBOARD_HEIGHT });
    const release = holdVisibleViewport();

    // WHEN the device turns, which resizes the viewport on its own account
    isPortraitStub = false;
    setInnerHeight(LANDSCAPE_HEIGHT);
    stubViewport({ height: LANDSCAPE_HEIGHT });

    // THEN the landscape measurement answers, not a portrait height that
    // describes nothing on this screen
    expect(readVisibleViewport()?.height).toBe(LANDSCAPE_HEIGHT);
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);

    // AND the release that owns it still balances
    release();
    expect(readVisibleViewport()?.height).toBe(LANDSCAPE_HEIGHT);
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

describe("window resizes", () => {
  const RESIZED_HEIGHT = REFERENCE_HEIGHT - 260;

  /** Shrink the window and its viewport the way a window resize does. */
  function resizeWindowTo(height: number): void {
    setInnerHeight(height);
    stubViewport({ height });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  test("rebases the reference onto a window a resize made shorter", () => {
    // GIVEN a mounted consumer with no keyboard up
    renderHook(() => useVisibleViewport());

    // WHEN a same-orientation resize (an iPad Stage Manager drag, a split-view
    // divider) shrinks the window past the keyboard threshold
    resizeWindowTo(RESIZED_HEIGHT);

    // THEN the shorter window is the new keyboard-free reference, rather than a
    // keyboard that never goes away and arms the swipe-down dismiss gesture
    // over the whole surface
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(RESIZED_HEIGHT);
  });

  test("leaves the reference alone for the frame resize a keyboard announced", () => {
    // GIVEN a shell that resizes its own web view frame for the keyboard, which
    // it announces first
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);

    // WHEN that deferred resize lands, shrinking the window with it
    resizeWindowTo(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // THEN the keyboard-free reference survives it, so the shell keeps sizing
    // for the keyboard the user is looking at
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });

  test("rebases with the composer focused when no keyboard was announced", () => {
    // GIVEN a composer holding focus with nothing announced, which is what a
    // hardware keyboard on a tablet looks like: focus with no soft keyboard
    renderHook(() => useVisibleViewport());
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();

    // WHEN split view shortens the window under it
    resizeWindowTo(RESIZED_HEIGHT);

    // THEN focus is not mistaken for a keyboard, so the shorter window still
    // becomes the reference and the gesture stays disarmed
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(RESIZED_HEIGHT);
    composer.remove();
  });

  test("leaves the reference alone once the keyboard is announced away again", () => {
    // GIVEN a shell whose keyboard opened and closed, so it has announced
    // before but reports nothing up now
    renderHook(() => useVisibleViewport());
    announce(KEYBOARD_HEIGHT);
    announce(0);

    // WHEN a later keyboard shrinks the frame with its own announcement
    announce(KEYBOARD_HEIGHT);
    resizeWindowTo(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // THEN the reference still survives it
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });

  test("keeps the reference on a shell that reports no keyboard source", () => {
    // GIVEN a shell built before `@capacitor/keyboard`, which the deployed web
    // bundle still runs in, so nothing will ever announce its keyboard
    stubReportsKeyboardSource = false;
    renderHook(() => useVisibleViewport());

    // WHEN that shell resizes its own web view for the soft keyboard
    resizeWindowTo(REFERENCE_HEIGHT - KEYBOARD_HEIGHT);

    // THEN the reference survives, because rebasing here would swallow the
    // keyboard and leave the composer behind it
    expect(readVisibleViewport()?.keyboardHeight).toBe(KEYBOARD_HEIGHT);
  });

  test("holds the reference when the source reports in, which proves nothing", () => {
    // GIVEN a shell whose plugin listeners are still registering, which is a
    // lazy import away on every boot, and a frame that shrank in that window
    stubReportsKeyboardSource = false;
    renderHook(() => useVisibleViewport());
    resizeWindowTo(RESIZED_HEIGHT);

    // WHEN the source reports in, the one moment that cannot tell a shrinking
    // window from a keyboard that opened before anything could announce it
    act(() => {
      reportKeyboardSource!();
    });

    // THEN the reference stands. Rebasing here onto a keyboard-sized frame
    // would report no keyboard for as long as the keyboard is up; standing
    // still only reports one that is not there, and that corrects itself.
    expect(readVisibleViewport()?.keyboardHeight).toBe(
      REFERENCE_HEIGHT - RESIZED_HEIGHT,
    );
  });

  test("settles that shrink on the next resize, once the source is known", () => {
    // GIVEN the same deferred shrink, with the source now reported
    stubReportsKeyboardSource = false;
    renderHook(() => useVisibleViewport());
    resizeWindowTo(RESIZED_HEIGHT);
    act(() => {
      reportKeyboardSource!();
    });

    // WHEN any further resize arrives, which a window drag emits continuously
    resizeWindowTo(RESIZED_HEIGHT);

    // THEN the reference follows the window down and the phantom keyboard goes
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(RESIZED_HEIGHT);
  });

  test("grows back to a window returning to full height", () => {
    // The other way the too-tall reference resolves itself, with no resize
    // needed while the source is still registering.
    stubReportsKeyboardSource = false;
    renderHook(() => useVisibleViewport());
    resizeWindowTo(RESIZED_HEIGHT);
    act(() => {
      reportKeyboardSource!();
    });

    resizeWindowTo(REFERENCE_HEIGHT);

    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });

  test("keeps the reference when a show announces a malformed height", () => {
    // The bridge coerces a malformed payload to `0`. The keyboard is still
    // coming up, so the frame resize behind it is not the window shrinking.
    renderHook(() => useVisibleViewport());
    announce(0, true);

    resizeWindowTo(RESIZED_HEIGHT);

    // The reference stands, so the shrunken frame still reads as a keyboard
    // rather than as the window's new height.
    expect(readVisibleViewport()?.keyboardHeight).toBe(
      REFERENCE_HEIGHT - RESIZED_HEIGHT,
    );
  });

  test("waits for an announcement on a shell before trusting a quiet keyboard", () => {
    // A keyboard raised while the plugin listeners were registering announces
    // nothing, so silence here is not proof that the frame shrank for the
    // window. The deferred frame resize must not be taken as the window's own.
    stubIsNativeMobile = true;
    renderHook(() => useVisibleViewport());

    resizeWindowTo(RESIZED_HEIGHT);

    expect(readVisibleViewport()?.keyboardHeight).toBe(
      REFERENCE_HEIGHT - RESIZED_HEIGHT,
    );
  });

  test("rebases on a shell once an announcement has been heard", () => {
    // A hide is an answer, where silence was not. From here a shrink is the
    // window's own and the reference follows it.
    stubIsNativeMobile = true;
    renderHook(() => useVisibleViewport());
    announce(0, false);

    resizeWindowTo(RESIZED_HEIGHT);

    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(RESIZED_HEIGHT);
  });

  test("rebases in a browser with no announcement, having nothing to wait for", () => {
    // A browser keyboard leaves `window.innerHeight` alone, so every shrink
    // there is the window's own and there is no ambiguity to resolve.
    renderHook(() => useVisibleViewport());

    resizeWindowTo(RESIZED_HEIGHT);

    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(RESIZED_HEIGHT);
  });

  test("ignores a window that grew, which the reference already tracks", () => {
    // GIVEN a window shortened by a resize
    renderHook(() => useVisibleViewport());
    resizeWindowTo(RESIZED_HEIGHT);

    // WHEN it is pulled back out
    resizeWindowTo(REFERENCE_HEIGHT);

    // THEN the taller window is the reference again and no keyboard is reported
    const viewport = readVisibleViewport();
    expect(viewport?.keyboardHeight).toBe(0);
    expect(viewport?.height).toBe(REFERENCE_HEIGHT);
  });
});
