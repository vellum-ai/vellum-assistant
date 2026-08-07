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
  callOnStart,
  callOnUpdate,
  shouldShowCompanionSurface,
  canvasOriginForAvatarCentre,
  parkedOriginForSnap,
  canHostDictation,
} = await import("./companion-window");

/** A session as the mirror publishes one, before main stamps its clock. */
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
describe("the session main holds", () => {
  test("start stamps the clock", () => {
    expect(callOnStart(null, START, 1_000).startedAt).toBe(1_000);
  });

  test("a redundant start updates the session without restarting its clock", () => {
    const running = callOnStart(null, START, 1_000);
    const again = callOnStart(running, { ...START, phase: "thinking" }, 9_000);
    expect(again.startedAt).toBe(1_000);
    expect(again.phase).toBe("thinking");
  });

  test("update merges content and leaves the fixed fields alone", () => {
    const running = callOnStart(null, START, 1_000);
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
    const running = callOnStart(null, START, 1_000);
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

/**
 * Whether the surface takes a dictation session or leaves it to the overlay.
 *
 * Taking one suppresses the top-center overlay, so declining has to be the
 * answer whenever the surface could not actually draw the session: the user
 * would otherwise dictate with no transcription and no stop control anywhere.
 */
describe("canHostDictation", () => {
  test("takes the session while on screen and idle", () => {
    expect(canHostDictation(true, false)).toBe(true);
  });

  test("declines while off screen, which is what the overlay is for", () => {
    expect(canHostDictation(false, false)).toBe(false);
  });

  // The composer holds a half-typed message that closing would throw away, and
  // the pill draws one thing at a time. Hosting here would suppress the overlay
  // and then render the card over the session it just took.
  test("declines while the composer is open, draft intact", () => {
    expect(canHostDictation(true, true)).toBe(false);
  });
});

/**
 * Where the window goes when a dictation session calls the surface to the
 * cursor.
 *
 * The canvas is far larger than the circle drawn in it, so every position is
 * stated as the avatar's centre and backed out by half the canvas. That
 * arithmetic is the whole of the bug surface here: off by the wrong half and
 * the avatar lands a third of a screen from the pointer that summoned it.
 */
describe("canvasOriginForAvatarCentre", () => {
  // Half of `CANVAS_WIDTH` (724) and `CANVAS_HEIGHT` (584): what the avatar's
  // centre is offset by to become the window's own origin.
  const HALF_W = 362;
  const HALF_H = 292;
  // Half the avatar's 44pt box, which is how close its centre may get to an
  // edge before the circle would start leaving the display.
  const HALF_AVATAR = 22;
  const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 };

  test("centres the avatar on the point", () => {
    expect(canvasOriginForAvatarCentre({ x: 720, y: 450 }, WORK_AREA)).toEqual({
      x: 720 - HALF_W,
      y: 450 - HALF_H,
    });
  });

  test("holds the avatar inside the top-left corner", () => {
    expect(canvasOriginForAvatarCentre({ x: 0, y: 0 }, WORK_AREA)).toEqual({
      x: HALF_AVATAR - HALF_W,
      y: HALF_AVATAR - HALF_H,
    });
  });

  test("holds the avatar inside the bottom-right corner", () => {
    expect(canvasOriginForAvatarCentre({ x: 1440, y: 900 }, WORK_AREA)).toEqual(
      {
        x: 1440 - HALF_AVATAR - HALF_W,
        y: 900 - HALF_AVATAR - HALF_H,
      },
    );
  });

  test("the canvas is allowed off the display, the avatar is not", () => {
    // The origin lands well outside the work area at every edge, which is the
    // point: clamping the canvas instead would keep the circle 362pt from the
    // left of every display and 292pt from the top.
    const origin = canvasOriginForAvatarCentre({ x: 0, y: 0 }, WORK_AREA);
    expect(origin.x).toBeLessThan(WORK_AREA.x);
    expect(origin.y).toBeLessThan(WORK_AREA.y);
  });

  test("clamps against the display's own origin, not the screen's", () => {
    // A second display to the right of the primary. A cursor on its left edge
    // is at x=1440 in screen coordinates, which is inside this display and must
    // not be pulled to the primary's bounds.
    const secondary = { x: 1440, y: 0, width: 1440, height: 900 };
    expect(canvasOriginForAvatarCentre({ x: 1440, y: 450 }, secondary)).toEqual(
      {
        x: 1440 + HALF_AVATAR - HALF_W,
        y: 450 - HALF_H,
      },
    );
  });

  test("rounds to whole points", () => {
    // Electron takes integers, and a fractional position is silently truncated
    // somewhere further down rather than rejected.
    const origin = canvasOriginForAvatarCentre(
      { x: 720.6, y: 450.4 },
      WORK_AREA,
    );
    expect(Number.isInteger(origin.x)).toBe(true);
    expect(Number.isInteger(origin.y)).toBe(true);
  });

  test("a work area narrower than the avatar resolves to its near edge", () => {
    // The bounds cross over here, so the two clamps disagree. Answering with
    // the near edge keeps the arithmetic total rather than returning something
    // outside the display on the far side.
    const sliver = { x: 0, y: 0, width: 30, height: 30 };
    expect(canvasOriginForAvatarCentre({ x: 15, y: 15 }, sliver)).toEqual({
      x: HALF_AVATAR - HALF_W,
      y: HALF_AVATAR - HALF_H,
    });
  });
});

/**
 * The spot the surface goes back to when the session that moved it ends.
 *
 * The rule is one line and the bug it prevents is not obvious: a session pushes
 * many states, and re-reading the window's position on any of them would record
 * the cursor the session had already moved it to.
 */
describe("parkedOriginForSnap", () => {
  test("records where the surface was parked on the first snap", () => {
    expect(parkedOriginForSnap(null, { x: 100, y: 200 })).toEqual({
      x: 100,
      y: 200,
    });
  });

  test("a later snap in the same session does not overwrite it", () => {
    const parked = parkedOriginForSnap(null, { x: 100, y: 200 });
    // The surface has since been moved to the cursor. Recording that would put
    // the return at the cursor rather than at the spot the user chose.
    expect(parkedOriginForSnap(parked, { x: 900, y: 40 })).toEqual({
      x: 100,
      y: 200,
    });
  });
});
