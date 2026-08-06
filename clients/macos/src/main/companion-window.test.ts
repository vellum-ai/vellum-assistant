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
const { anchorFor, callOnStart, callOnUpdate } = await import(
  "./companion-window"
);

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
 * The anchor is the only rule in the companion window worth testing without a
 * window server: everything else is Electron plumbing. It decides whether the
 * pill can bloom both ways or has to flip, and getting it wrong means the
 * surface grows off the side of the display taking the avatar with it.
 */

// A 1440pt display with no menu-bar offset, which keeps the arithmetic in the
// cases readable.
const DISPLAY = { x: 0, width: 1440 };

// (360 - 44) / 2, the clearance bloom needs either side at its widest.
const NEEDED = 158;

describe("anchorFor", () => {
  test("blooms both ways with room on each side", () => {
    expect(anchorFor(720, DISPLAY)).toBe("center");
  });

  test("flips to left-anchored when the left runs out", () => {
    expect(anchorFor(40, DISPLAY)).toBe("left");
  });

  test("flips to right-anchored when the right runs out", () => {
    expect(anchorFor(1400, DISPLAY)).toBe("right");
  });

  test("exactly enough room on both sides still blooms", () => {
    expect(anchorFor(NEEDED, DISPLAY)).toBe("center");
    expect(anchorFor(DISPLAY.width - NEEDED, DISPLAY)).toBe("center");
  });

  test("one pixel short on the left flips", () => {
    expect(anchorFor(NEEDED - 1, DISPLAY)).toBe("left");
  });

  test("one pixel short on the right flips", () => {
    expect(anchorFor(DISPLAY.width - NEEDED + 1, DISPLAY)).toBe("right");
  });

  test("measures against the display's own origin, not the screen's", () => {
    // A second display to the right of the primary. Its left edge is 1440, so
    // an avatar just inside it has no left clearance even though its absolute
    // x is large.
    const secondary = { x: 1440, width: 1440 };
    expect(anchorFor(1480, secondary)).toBe("left");
    expect(anchorFor(2160, secondary)).toBe("center");
  });

  test("a display narrower than the pill prefers the left edge", () => {
    // Both sides are short, so the check order decides. Left wins, which keeps
    // the avatar visible and pushes the overflow to the right where a partially
    // drawn pill is still reachable.
    const narrow = { x: 0, width: 200 };
    expect(anchorFor(100, narrow)).toBe("left");
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
