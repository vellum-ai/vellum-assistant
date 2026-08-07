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
const { growthFor, callOnStart, callOnUpdate, shouldShowCompanionSurface } =
  await import("./companion-window");

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
