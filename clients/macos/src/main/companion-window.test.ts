import { describe, expect, mock, test } from "bun:test";

// The module under test reaches `main-window.ts` to hand Talk to the renderer
// that owns the live-voice session, and that chain loads `electron-store`, a
// real module that imports the Electron binary's default export and cannot
// resolve off-Electron. Only the import chain needs satisfying here: these
// cases exercise the anchor, which touches no store. Same shape as
// `window-state.test.ts`, which mocks it for the same reason.
mock.module("electron-store", () => ({
  default: class {
    get(_key: string, fallback?: unknown) {
      return fallback;
    }
    set() {}
  },
}));

// Dynamic, so the mock above is installed before the module graph loads:
// static imports hoist above it.
const {
  growthFor,
  clampCanvasOrigin,
  callOnUpdate,
  shouldShowCompanionSurface,
} = await import("./companion-window");

/** A session as the mirror publishes one, which is what main then holds. */
const START = {
  phase: "listening",
  label: "Listening",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
} as const;

/**
 * The growth direction is the only rule in the companion window worth testing
 * without a window server: everything else is Electron plumbing. It decides
 * which way the pill unfurls out of the avatar, and getting it wrong runs the
 * controls off the side of the display.
 */

// A 1440pt display with no menu-bar offset, which keeps the arithmetic in the
// cases readable.
const DISPLAY = { x: 0, width: 1440 };

// 360 - 44: the clearance the body needs on the side it grows into.
const NEEDED = 316;

describe("growthFor", () => {
  test("grows rightward with room to the right", () => {
    expect(growthFor(720, DISPLAY)).toBe("right");
  });

  test("still grows rightward hard against the left edge", () => {
    // Growth runs away from the edge here, so there is nothing to flip.
    expect(growthFor(40, DISPLAY)).toBe("right");
  });

  test("flips leftward when the right runs out", () => {
    expect(growthFor(1400, DISPLAY)).toBe("left");
  });

  test("exactly enough room on the right still grows rightward", () => {
    expect(growthFor(DISPLAY.width - NEEDED, DISPLAY)).toBe("right");
  });

  test("one pixel short on the right flips", () => {
    expect(growthFor(DISPLAY.width - NEEDED + 1, DISPLAY)).toBe("left");
  });

  test("measures against the display's own origin, not the screen's", () => {
    // A second display to the right of the primary. Its right edge is 2880, so
    // an avatar near it has no room even though its absolute x is large.
    const secondary = { x: 1440, width: 1440 };
    expect(growthFor(2840, secondary)).toBe("left");
    expect(growthFor(1600, secondary)).toBe("right");
  });

  test("a display too narrow for either direction still grows right", () => {
    // The clipping is unavoidable, and the user can drag the surface somewhere
    // it fits. Flipping would only move which end is cut off.
    const narrow = { x: 0, width: 200 };
    expect(growthFor(100, narrow)).toBe("right");
  });
});

/**
 * The two rules main applies to the session it holds for the surface. Both are
 * about the elapsed clock, which is the one thing on the call pill that main
 * owns rather than passes through.
 */
/**
 * The clamp is the other half of that: growth decides which way the pill
 * unfurls, and this decides whether the avatar it unfurls from is still
 * somewhere the user can reach. A surface pushed off the display cannot be
 * dragged back, because there is nothing left on screen to grab.
 */

// The canvas the avatar is centred in, from the constants the module derives
// them from: 360 wide at most, a 44 avatar, 24 of shadow padding.
const CANVAS_WIDTH = (360 - 44 / 2) * 2 + 24 * 2;
const CANVAS_HEIGHT = (290 - 44 / 2 + 24) * 2;

/** A 1440x900 display with the menu bar taken off the top. */
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** The canvas origin that puts the avatar's centre exactly here. */
const originFor = (centreX: number, centreY: number) => ({
  x: centreX - CANVAS_WIDTH / 2,
  y: centreY - CANVAS_HEIGHT / 2,
});

/** Where the avatar's centre ends up for a given canvas origin. */
const centreOf = (origin: { x: number; y: number }) => ({
  x: origin.x + CANVAS_WIDTH / 2,
  y: origin.y + CANVAS_HEIGHT / 2,
});

describe("clampCanvasOrigin", () => {
  test("leaves a position inside the work area alone", () => {
    const origin = originFor(700, 500);
    expect(clampCanvasOrigin(origin, WORK_AREA)).toEqual({
      x: Math.round(origin.x),
      y: Math.round(origin.y),
    });
  });

  test("holds the avatar at the right edge rather than past it", () => {
    const flung = originFor(9000, 500);
    expect(centreOf(clampCanvasOrigin(flung, WORK_AREA)).x).toBe(1440 - 22);
  });

  test("holds the avatar at the left edge rather than past it", () => {
    const flung = originFor(-9000, 500);
    expect(centreOf(clampCanvasOrigin(flung, WORK_AREA)).x).toBe(22);
  });

  test("keeps the avatar below the menu bar", () => {
    const flung = originFor(700, -9000);
    expect(centreOf(clampCanvasOrigin(flung, WORK_AREA)).y).toBe(25 + 22);
  });

  test("holds the avatar at the bottom edge rather than past it", () => {
    const flung = originFor(700, 9000);
    expect(centreOf(clampCanvasOrigin(flung, WORK_AREA)).y).toBe(900 - 22);
  });

  /**
   * The canvas is far wider than the avatar, so a clamp written against the
   * canvas box would refuse to let the avatar anywhere near the edge. The
   * corner is exactly where the surface is meant to rest.
   */
  test("lets the avatar reach the corner the surface opens in", () => {
    const corner = originFor(1440 - 22, 900 - 22);
    expect(centreOf(clampCanvasOrigin(corner, WORK_AREA))).toEqual({
      x: 1440 - 22,
      y: 900 - 22,
    });
  });

  test("clamps against the display it is given, not the primary one", () => {
    const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
    const flung = originFor(99999, 500);
    expect(centreOf(clampCanvasOrigin(flung, secondary)).x).toBe(
      1440 + 1920 - 22,
    );
  });

  test("stays inside a work area too small for the avatar", () => {
    const tiny = { x: 0, y: 0, width: 10, height: 10 };
    const centre = centreOf(clampCanvasOrigin(originFor(9000, 9000), tiny));
    expect(centre.x).toBeLessThanOrEqual(10);
    expect(centre.y).toBeLessThanOrEqual(10);
  });
});

describe("the session main holds", () => {
  test("update merges content and leaves the fixed fields alone", () => {
    const running = { ...START };
    const next = callOnUpdate(running, { phase: "speaking", detail: "Reading" });
    expect(next).toEqual({
      ...running,
      phase: "speaking",
      detail: "Reading",
    });
  });

  test("update with no running session is dropped rather than promoted", () => {
    // It carries no assistant name and no avatar, so honoring it would put an
    // anonymous call on the surface.
    expect(callOnUpdate(null, { phase: "speaking" })).toBeNull();
  });

  test("carries the pending approval through", () => {
    const running = { ...START };
    expect(
      callOnUpdate(running, { approvalRequestId: "req-1" })?.approvalRequestId,
    ).toBe("req-1");
  });
});

/**
 * The surface is the most conspicuous thing this app puts on screen, so what
 * decides whether it appears is worth stating as cases: the flag is a floor and
 * the tray preference is a veto.
 */
describe("shouldShowCompanionSurface", () => {
  test("shows for a targeted user who has not hidden it", () => {
    expect(shouldShowCompanionSurface(true, false)).toBe(true);
  });

  test("stays away while the flag is off", () => {
    expect(shouldShowCompanionSurface(false, false)).toBe(false);
  });

  test("honours the tray preference even while the flag is on", () => {
    expect(shouldShowCompanionSurface(true, true)).toBe(false);
  });

  // The pre-flag state of every launch: main reads the flags the app's window
  // wrote last time, and a fresh install has none.
  test("stays away when nothing is known yet", () => {
    expect(shouldShowCompanionSurface(false, false)).toBe(false);
  });
});
