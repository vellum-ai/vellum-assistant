import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  COMPANION_SIZES,
  type CompanionSurfaceState,
  type VellumCommand,
} from "@vellumai/ipc-contract";

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

// The rest of the module's graph, stubbed down to what the IPC cases need: the
// registrars the handlers land in, the surface they push to, and the app's
// window they dispatch at. Everything main does against a real window server is
// out of reach here, and none of it is what these cases are about.

/** Every state main has pushed to the surface, most recent last. */
const pushes: CompanionSurfaceState[] = [];

/** Every command main has handed to the app's renderer, most recent last. */
const dispatched: VellumCommand[] = [];

/** How many times a press had to build a window before it could land. */
let windowsRaised = 0;

/** Whether the app's window exists, which is what decides between those two. */
let mainWindowOpen = true;

const surface = {
  webContents: {
    send: (_channel: string, state: CompanionSurfaceState) => {
      pushes.push(state);
    },
  },
};

type Invoker = (args: unknown[]) => unknown;

/** Channel to handler, with the channel's schema applied the way `on` does. */
const listeners = new Map<string, Invoker>();
const invocable = new Map<string, Invoker>();

const register =
  (into: Map<string, Invoker>) =>
  (
    channel: string,
    schema: { parse: (input: unknown) => unknown },
    fn: (args: never) => unknown,
  ): void => {
    into.set(channel, (args) => fn(schema.parse(args) as never));
  };

mock.module("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    on: () => undefined,
  },
}));

mock.module("./ipc", () => ({
  on: register(listeners),
  handle: register(invocable),
}));

mock.module("./main-window", () => ({
  // Only its existence is read: it is what decides whether a press is
  // dispatched straight into a renderer or has to build one first.
  current: () => (mainWindowOpen ? {} : null),
  dispatchToMain: (command: VellumCommand) => {
    dispatched.push(command);
  },
  ensureVisible: () => {
    windowsRaised += 1;
    return Promise.resolve();
  },
}));

mock.module("@vellumai/electron-desktop/floating-window", () => ({
  createFloatingWindow: () => surface,
  getFloatingWindow: () => surface,
}));

mock.module("@vellumai/electron-desktop/avatar", () => ({
  getAvatarPng: () => null,
  getCharacter: () => null,
  onAvatarChange: () => () => {},
}));

mock.module("@vellumai/electron-desktop/settings", () => ({
  readSetting: () => ({ "companion-surface": true }),
  onSettingChange: () => () => {},
}));

mock.module("@vellumai/electron-desktop/window-state", () => ({
  readCompanionSize: () => "small",
  readCompanionHidden: () => false,
  writeCompanionSize: () => {},
  writeCompanionHidden: () => {},
}));

// Dynamic, so the mocks above are installed before the module graph loads:
// static imports hoist above them.
const {
  growthFor,
  cardGrowthFor,
  avatarOffsetFor,
  geometryFor,
  placeCanvas,
  callOnUpdate,
  shouldShowCompanionSurface,
  installCompanionWindow,
} = await import("./companion-window");

installCompanionWindow();

/** Send on a channel exactly as a renderer would, schema and all. */
const send = (channel: string, ...args: unknown[]): void => {
  const listener = listeners.get(channel);
  if (!listener) {
    throw new Error(`No listener registered for ${channel}`);
  }
  listener(args);
};

/** The state a renderer mounting on the surface would pull. */
const state = (): CompanionSurfaceState => {
  const pull = invocable.get("vellum:companion:getState");
  if (!pull) {
    throw new Error("No handler registered for vellum:companion:getState");
  }
  return pull([]) as CompanionSurfaceState;
};

/** A context as the app's window publishes one. */
const context = (over: Record<string, unknown> = {}) => ({
  assistantName: "Ziggy",
  turns: [],
  working: false,
  ...over,
});

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
    expect(growthFor(720, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("still grows rightward hard against the left edge", () => {
    // Growth runs away from the edge here, so there is nothing to flip.
    expect(growthFor(40, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("flips leftward when the right runs out", () => {
    expect(growthFor(1400, DISPLAY, GEOMETRY)).toBe("left");
  });

  test("exactly enough room on the right still grows rightward", () => {
    expect(growthFor(DISPLAY.width - NEEDED, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("one pixel short on the right flips", () => {
    expect(growthFor(DISPLAY.width - NEEDED + 1, DISPLAY, GEOMETRY)).toBe("left");
  });

  test("measures against the display's own origin, not the screen's", () => {
    // A second display to the right of the primary. Its right edge is 2880, so
    // an avatar near it has no room even though its absolute x is large.
    const secondary = { x: 1440, width: 1440 };
    expect(growthFor(2840, secondary, GEOMETRY)).toBe("left");
    expect(growthFor(1600, secondary, GEOMETRY)).toBe("right");
  });

  test("a display too narrow for either direction still grows right", () => {
    // The clipping is unavoidable, and the user can drag the surface somewhere
    // it fits. Flipping would only move which end is cut off.
    const narrow = { x: 0, width: 200 };
    expect(growthFor(100, narrow, GEOMETRY)).toBe("right");
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

/**
 * The size the placement cases are written against, which is the one the
 * renderer's layout is authored at. Every other size is the same arithmetic
 * scaled, which `geometryFor` has its own cases for.
 */
const GEOMETRY = geometryFor("small");
const CANVAS_WIDTH = GEOMETRY.canvasWidth;
const RISE_ABOVE = GEOMETRY.riseAbove;
const DROP_BELOW = GEOMETRY.dropBelow;

/** A 1440x900 display with the menu bar taken off the top. */
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** Where the avatar's centre ends up for a given placement. */
const centreOf = (
  placed: ReturnType<typeof placeCanvas>,
  geometry = GEOMETRY,
) => ({
  x: placed.origin.x + geometry.canvasWidth / 2,
  y: placed.origin.y + avatarOffsetFor(placed.cardGrowth, geometry),
});

describe("placeCanvas", () => {
  test("puts the avatar exactly where a position inside the work area asks", () => {
    expect(centreOf(placeCanvas({ x: 700, y: 500 }, WORK_AREA, GEOMETRY))).toEqual({
      x: 700,
      y: 500,
    });
  });

  test("holds the avatar at the right edge rather than past it", () => {
    expect(centreOf(placeCanvas({ x: 9000, y: 500 }, WORK_AREA, GEOMETRY)).x).toBe(
      1440 - 22,
    );
  });

  test("holds the avatar at the left edge rather than past it", () => {
    expect(centreOf(placeCanvas({ x: -9000, y: 500 }, WORK_AREA, GEOMETRY)).x).toBe(22);
  });

  test("holds the avatar at the bottom edge rather than past it", () => {
    expect(centreOf(placeCanvas({ x: 700, y: 9000 }, WORK_AREA, GEOMETRY)).y).toBe(
      900 - 22,
    );
  });

  /**
   * The canvas is far wider than the avatar, so a clamp written against the
   * canvas box would refuse to let the avatar anywhere near the edge. The
   * corner is exactly where the surface is meant to rest.
   */
  test("lets the avatar reach the corner the surface opens in", () => {
    expect(
      centreOf(placeCanvas({ x: 1440 - 22, y: 900 - 22 }, WORK_AREA, GEOMETRY)),
    ).toEqual({ x: 1440 - 22, y: 900 - 22 });
  });

  test("clamps against the display it is given, not the primary one", () => {
    const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(centreOf(placeCanvas({ x: 99999, y: 500 }, secondary, GEOMETRY)).x).toBe(
      1440 + 1920 - 22,
    );
  });

  /**
   * A work area smaller than the canvas cannot hold the avatar inside it and
   * keep the origin on screen, and the origin is the one macOS enforces. So the
   * honest guarantee is bounded, not exact: the surface does not fly off to
   * where the fling asked, and it asks for nothing the window server will
   * quietly rewrite. Asserting the avatar lands inside a 10pt display would be
   * asserting arithmetic that never survives contact with AppKit.
   */
  test("stays near a work area too small to hold the canvas", () => {
    const tiny = { x: 0, y: 0, width: 10, height: 10 };
    const placed = placeCanvas({ x: 9000, y: 9000 }, tiny, GEOMETRY);
    expect(placed.origin.y).toBeGreaterThanOrEqual(tiny.y);
    expect(centreOf(placed).x).toBeLessThanOrEqual(10);
    expect(centreOf(placed).y).toBeLessThanOrEqual(tiny.y + DROP_BELOW);
  });

  /**
   * JARVIS-1548. macOS refuses a window origin above the top of the work area
   * and hands back one flush with it, so an origin asked for any higher moves
   * the avatar somewhere neither side chose. Every position this returns has to
   * be one the window server will actually honour.
   */
  test("never asks for an origin above the work area", () => {
    for (const y of [-9000, -100, 0, 25, 40, 70, 71, 200, 400]) {
      expect(placeCanvas({ x: 700, y }, WORK_AREA, GEOMETRY).origin.y).toBeGreaterThanOrEqual(
        WORK_AREA.y,
      );
    }
  });

  /**
   * The bug as the user met it: the avatar stopped hundreds of points short of
   * the top for no visible reason. It was the canvas's upper half, which the
   * old symmetric canvas spent on a card that had nowhere to grow.
   */
  test("brings the avatar within a shadow's width of the top", () => {
    const centre = centreOf(placeCanvas({ x: 700, y: -9000 }, WORK_AREA, GEOMETRY));
    expect(centre.y).toBe(WORK_AREA.y + DROP_BELOW);
    // Where it used to stop: the old canvas's half-height below the work area.
    expect(centre.y).toBeLessThan(WORK_AREA.y + RISE_ABOVE);
  });
});

describe("cardGrowthFor", () => {
  test("grows up with room for the card above the avatar", () => {
    expect(cardGrowthFor(500, WORK_AREA, GEOMETRY)).toBe("up");
  });

  test("grows down when the card would not fit above", () => {
    expect(cardGrowthFor(WORK_AREA.y + 40, WORK_AREA, GEOMETRY)).toBe("down");
  });

  test("flips exactly where the card stops fitting", () => {
    expect(cardGrowthFor(WORK_AREA.y + RISE_ABOVE, WORK_AREA, GEOMETRY)).toBe("up");
    expect(cardGrowthFor(WORK_AREA.y + RISE_ABOVE - 1, WORK_AREA, GEOMETRY)).toBe("down");
  });

  /**
   * Deliberately *not* the twin of "a display too narrow for either direction
   * still grows right". A canvas may hang off the sides of a display but not
   * off the top, so falling back to `up` here would reserve 292pt above an
   * avatar that has nowhere to put it and fence the mascot out of the top of a
   * short display. The card is already lost either way; the reach is not.
   */
  test("grows down on a display too short for the card either way", () => {
    const short = { y: 0, height: 100 };
    expect(cardGrowthFor(50, short, GEOMETRY)).toBe("down");
  });

  test("does not flip near the bottom, which is where the surface lives", () => {
    expect(cardGrowthFor(900 - 22, WORK_AREA, GEOMETRY)).toBe("up");
  });
});

describe("avatarOffsetFor", () => {
  /**
   * The avatar's offset is what converts a window origin into an avatar
   * position on both sides of the bridge. Growing up reserves the card's height
   * above it; growing down reserves only the avatar and its shadow.
   */
  test("reserves the card's height above the avatar when growing up", () => {
    expect(avatarOffsetFor("up", GEOMETRY)).toBe(RISE_ABOVE);
  });

  test("reserves only the shadow above it when growing down", () => {
    expect(avatarOffsetFor("down", GEOMETRY)).toBe(DROP_BELOW);
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

/**
 * The canvas as a function of the size the user picked (JARVIS-1549).
 *
 * The avatar's box is not a style: the pill's reach, the card's height and the
 * canvas sized to hold them all come off it. So the sizes are named steps, and
 * each one is a layout that can be stated rather than a point on a slider that
 * nobody ever looked at.
 */
describe("geometryFor", () => {
  test("draws `small` at the size the renderer's layout is authored at", () => {
    const small = geometryFor("small");
    expect(small.avatarBox).toBe(44);
    expect(small.canvasWidth).toBe(724);
    expect(small.canvasHeight).toBe(338);
  });

  /**
   * The whole surface is one layout multiplied, so every length has to move
   * together. A canvas that scaled while the pill's reach did not would clip
   * the controls; the reverse would swallow clicks over empty desktop.
   */
  test("scales every length by the same factor", () => {
    const small = geometryFor("small");
    const large = geometryFor("large");
    const scale = large.avatarBox / small.avatarBox;
    expect(scale).toBe(2);
    expect(large.canvasWidth).toBe(small.canvasWidth * scale);
    expect(large.canvasHeight).toBe(small.canvasHeight * scale);
    expect(large.riseAbove).toBe(small.riseAbove * scale);
    expect(large.dropBelow).toBe(small.dropBelow * scale);
    expect(large.maxPillWidth).toBe(small.maxPillWidth * scale);
  });

  test("grows monotonically through the named steps", () => {
    const boxes = COMPANION_SIZES.map((size) => geometryFor(size).avatarBox);
    expect(boxes).toEqual([...boxes].sort((a, b) => a - b));
    expect(new Set(boxes).size).toBe(boxes.length);
  });

  /**
   * The canvas is a window size, and a window cannot be a fraction of a point.
   * The offsets are not rounded, because they are arithmetic on the way to a
   * position that is.
   */
  test("gives every size a whole-point canvas", () => {
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size);
      expect(Number.isInteger(geometry.canvasWidth)).toBe(true);
      expect(Number.isInteger(geometry.canvasHeight)).toBe(true);
    }
  });

  /**
   * The asymmetry that JARVIS-1548 bought has to survive being scaled: the card
   * side reserves its height, the other side reserves the avatar and its
   * shadow, and the second stays much the smaller of the two at every size.
   */
  test("keeps the canvas asymmetric about the avatar at every size", () => {
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size);
      expect(geometry.dropBelow).toBeLessThan(geometry.riseAbove);
      expect(geometry.riseAbove + geometry.dropBelow).toBe(
        geometry.canvasHeight,
      );
    }
  });
});

/**
 * The placement rules against a size other than the one they were written for.
 *
 * A bigger avatar makes the top-of-screen limit worse rather than better, since
 * the canvas grows with it, which is exactly why JARVIS-1548 had to land
 * first. What must hold is that the rules still bind on the avatar rather than
 * the canvas, at whatever size.
 */
describe("placing a larger companion", () => {
  const LARGE = geometryFor("large");

  test("holds the avatar at the edges by its own box, not the canvas", () => {
    const placed = placeCanvas({ x: 9000, y: 500 }, WORK_AREA, LARGE);
    expect(centreOf(placed, LARGE).x).toBe(1440 - LARGE.avatarBox / 2);
  });

  test("still never asks for an origin above the work area", () => {
    for (const y of [-9000, 0, 25, 100, 400]) {
      expect(
        placeCanvas({ x: 700, y }, WORK_AREA, LARGE).origin.y,
      ).toBeGreaterThanOrEqual(WORK_AREA.y);
    }
  });

  /**
   * The gap left at the top is the shadow's room, so it scales with everything
   * else. Bigger is a worse ceiling than `small` and still nothing like the
   * canvas half-height the bug was.
   */
  test("reaches the top, short by its own scaled shadow", () => {
    const centre = centreOf(placeCanvas({ x: 700, y: -9000 }, WORK_AREA, LARGE), LARGE);
    expect(centre.y).toBe(WORK_AREA.y + LARGE.dropBelow);
    expect(centre.y).toBeLessThan(WORK_AREA.y + LARGE.riseAbove);
  });

  test("flips the card at its own threshold, not the small one", () => {
    expect(cardGrowthFor(WORK_AREA.y + LARGE.riseAbove, WORK_AREA, LARGE)).toBe(
      "up",
    );
    expect(
      cardGrowthFor(WORK_AREA.y + LARGE.riseAbove - 1, WORK_AREA, LARGE),
    ).toBe("down");
  });
});

/**
 * The watch session, as far as main is concerned: a press it forwards and a
 * fact it holds. Main runs no session of its own, so what is worth stating is
 * that the press does not drag the app over the screen being watched, and that
 * the surface keeps being told whether a session is running across its own
 * renderer reloading.
 */
describe("the watch session main relays", () => {
  beforeEach(() => {
    dispatched.length = 0;
    windowsRaised = 0;
    mainWindowOpen = true;
    send("vellum:companion:setContext", context({ watching: false }));
    pushes.length = 0;
  });

  test("hands the toggle to the app's renderer without raising it", () => {
    send("vellum:companion:toggleWatch");
    expect(dispatched).toEqual([{ kind: "toggleWatch" }]);
    // The whole point of the surface: the user is working somewhere else, and
    // here that work is what the session is for.
    expect(windowsRaised).toBe(0);
  });

  test("builds a window when there is none, rather than lose the press", () => {
    mainWindowOpen = false;
    send("vellum:companion:toggleWatch");
    expect(windowsRaised).toBe(1);
  });

  test("carries watching from the published context into pushed state", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(state().watching).toBe(true);
    send("vellum:companion:setContext", context({ watching: false }));
    expect(state().watching).toBe(false);
  });

  /**
   * The surface reloads, and a session whose indicator came back missing is a
   * screen being read with nothing on screen saying so.
   */
  test("still reports the session to a renderer that pulls state fresh", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(state()).toMatchObject({ assistantName: "Ziggy", watching: true });
  });

  /**
   * A publisher that predates the field, which the schema defaults. Absence is
   * the answer "no session", never a drawn indicator over a machine nobody is
   * watching.
   */
  test("reads a context with no watching at all as no session", () => {
    send("vellum:companion:setContext", context());
    expect(state().watching).toBe(false);
  });

  /**
   * One channel carries the whole snapshot, so a context that flips watching is
   * a single push. Pushing the fact separately from the context it arrived with
   * would send the surface two states for one publish, the first of them stale.
   */
  test("pushes once per change rather than once per fact", () => {
    send(
      "vellum:companion:setContext",
      context({ working: true, watching: true }),
    );
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ working: true, watching: true });
  });
});
