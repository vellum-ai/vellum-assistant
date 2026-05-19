/**
 * Tests for `readVisibleViewport`, the pure helper that backs
 * `useVisibleViewport`.
 *
 * The test process runs through `web/src/test-setup-dom.cjs` which injects
 * happy-dom globals and sets `window === globalThis`. We MUST NOT replace
 * `globalThis.window` itself — doing so breaks the invariant and corrupts
 * downstream test files that rely on `window`/`globalThis` identity for
 * happy-dom internals (e.g. `window.event`). Instead, every stub here
 * mutates only the specific properties that `readVisibleViewport` reads
 * (`innerHeight`, `visualViewport`) on the existing window object, and
 * restores the originals in `afterEach`.
 *
 * The hook itself is a thin wrapper around `readVisibleViewport` plus two
 * event listeners; verifying the helper covers all derivation logic, and a
 * source-surface check verifies the hook observes both `resize` and `scroll`
 * on the visual viewport.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readVisibleViewport } from "@/lib/hooks/use-visible-viewport.js";

// ---------------------------------------------------------------------------
// In-place window-property stub. The setup preload guarantees
// `window === globalThis`, so we just mutate properties on globalThis and
// restore their original descriptors in `afterEach`. This avoids the trap of
// replacing `globalThis.window` with a plain object (which would silently
// break every test file that runs after this one).
// ---------------------------------------------------------------------------

interface VisualViewportStub {
  height: number;
  width: number;
  scale: number;
  offsetTop: number;
  offsetLeft: number;
  pageTop: number;
  pageLeft: number;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  onresize: null;
  onscroll: null;
}

const VISUAL_VIEWPORT_DEFAULTS: VisualViewportStub = {
  height: 0,
  width: 0,
  scale: 1,
  offsetTop: 0,
  offsetLeft: 0,
  pageTop: 0,
  pageLeft: 0,
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  onresize: null,
  onscroll: null,
};

const _PROPS = ["innerHeight", "visualViewport"] as const;
type StubbableProp = (typeof PROPS)[number];

const savedDescriptors = new Map<StubbableProp, PropertyDescriptor | undefined>();

function setWindowProp(key: StubbableProp, value: unknown) {
  if (!savedDescriptors.has(key)) {
    savedDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
  }
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function restoreWindowProps() {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      // Property didn't exist before — best-effort delete. Restoring to its
      // pre-test absence is what keeps downstream test files clean.
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  savedDescriptors.clear();
}

function stubVisualViewport(overrides: Partial<VisualViewportStub>) {
  setWindowProp("visualViewport", { ...VISUAL_VIEWPORT_DEFAULTS, ...overrides });
}

function clearVisualViewport() {
  setWindowProp("visualViewport", undefined);
}

function stubInnerHeight(value: number) {
  setWindowProp("innerHeight", value);
}

describe("readVisibleViewport", () => {
  afterEach(restoreWindowProps);

  test("returns null when the browser lacks the VisualViewport API", () => {
    // Covers both the SSR-no-window path and the no-visualViewport path —
    // both fall through the same `!window.visualViewport` guard, which is
    // the only behaviour callers can observe.
    clearVisualViewport();
    expect(readVisibleViewport()).toBeNull();
  });

  test("returns zero keyboard/offset when no keyboard is visible", () => {
    stubInnerHeight(800);
    stubVisualViewport({ height: 800, scale: 1, offsetTop: 0, offsetLeft: 0 });
    expect(readVisibleViewport()).toEqual({
      height: 800,
      keyboardHeight: 0,
      offsetTop: 0,
      offsetLeft: 0,
    });
  });

  test("derives keyboardHeight from innerHeight − visualViewport.height", () => {
    // iPhone-ish: layout viewport 800px, keyboard ~450px → visible 350px.
    stubInnerHeight(800);
    stubVisualViewport({ height: 350, scale: 1, offsetTop: 0, offsetLeft: 0 });
    expect(readVisibleViewport()).toEqual({
      height: 350,
      keyboardHeight: 450,
      offsetTop: 0,
      offsetLeft: 0,
    });
  });

  test("exposes visualViewport.offsetTop for callers to translate against", () => {
    // iOS keyboard auto-scroll: visible region starts 200px below the
    // layout viewport's top edge. The shell must apply a transform of this
    // amount or its header gets pushed behind the status bar.
    stubInnerHeight(800);
    stubVisualViewport({
      height: 350,
      scale: 1,
      offsetTop: 200,
      offsetLeft: 0,
    });
    expect(readVisibleViewport()).toEqual({
      height: 350,
      keyboardHeight: 450,
      offsetTop: 200,
      offsetLeft: 0,
    });
  });

  test("zeros offset and keyboardHeight while pinch-zoomed", () => {
    // Pinch-zoom shrinks visualViewport.height even when no keyboard is
    // present. We deliberately ignore zoom-induced shrinkage so the shell
    // doesn't false-trigger keyboard mode (and doesn't translate while the
    // user is panning a zoomed page).
    stubInnerHeight(800);
    stubVisualViewport({
      height: 400,
      scale: 2,
      offsetTop: 80,
      offsetLeft: 40,
    });
    expect(readVisibleViewport()).toEqual({
      height: 400,
      keyboardHeight: 0,
      offsetTop: 0,
      offsetLeft: 0,
    });
  });

  test("tolerates near-1.0 scale within the zoom-gate threshold", () => {
    // Browsers report scale ≈ 1.0001 even when the user hasn't zoomed
    // (DPI-related float drift). The 0.05 gate keeps this case in
    // "not zoomed" territory.
    stubInnerHeight(800);
    stubVisualViewport({
      height: 350,
      scale: 1.01,
      offsetTop: 200,
      offsetLeft: 0,
    });
    const result = readVisibleViewport();
    expect(result?.keyboardHeight).toBe(450);
    expect(result?.offsetTop).toBe(200);
  });

  test("clamps a negative innerHeight − height delta to 0", () => {
    // Defensive: iOS has been observed reporting a visualViewport.height
    // briefly larger than innerHeight during rotation. We never want a
    // negative keyboard height — it'd make `keyboardOpen` falsely true via
    // a magnitude comparison elsewhere.
    stubInnerHeight(800);
    stubVisualViewport({ height: 820, scale: 1, offsetTop: 0, offsetLeft: 0 });
    expect(readVisibleViewport()?.keyboardHeight).toBe(0);
  });
});

describe("useVisibleViewport — event-listener surface", () => {
  // Source-level assertion that the hook listens to BOTH `resize` and
  // `scroll` on `window.visualViewport`. The Chrome team's canonical
  // pattern requires both because `resize` fires on height/width changes
  // and `scroll` fires on offsetTop/offsetLeft changes — they're
  // independent events. Missing `scroll` is the exact regression that
  // caused LUM-1516 (composer overlapping the iOS status bar).
  //
  // https://developer.chrome.com/blog/visual-viewport-api/
  const source = readFileSync(
    join(__dirname, "use-visible-viewport.ts"),
    "utf8",
  );

  test("registers a `resize` listener on visualViewport", () => {
    expect(source).toContain('vv.addEventListener("resize"');
  });

  test("registers a `scroll` listener on visualViewport", () => {
    expect(source).toContain('vv.addEventListener("scroll"');
  });

  test("removes both listeners on cleanup", () => {
    expect(source).toContain('vv.removeEventListener("resize"');
    expect(source).toContain('vv.removeEventListener("scroll"');
  });
});
