import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_MAX_PILL_WIDTH,
  COMPANION_SIZES,
  COMPANION_SIZE_BOXES,
  companionNearEdgeFor,
  companionScaleFor,
  type CompanionSize,
  type CompanionSizeAxis,
  type CompanionSurfaceState,
  type VellumCommand,
} from "@vellumai/ipc-contract";
import { companionSizeSubmenus } from "@vellumai/electron-desktop/companion-menu";

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

/** Where the canvas's origin is, which is what the window reports and moves. */
let origin = { x: 0, y: 0 };

/** Every bounds main has asked the window server for, most recent last. */
const boundsSet: { x: number; y: number; width: number; height: number }[] = [];

const surface = {
  webContents: {
    send: (_channel: string, state: CompanionSurfaceState) => {
      pushes.push(state);
    },
  },
  // The surface's own flag going away closes the window, which a case moving
  // the flags can reach. Nothing here has a window server behind it, so this
  // only has to be callable.
  close: () => {},
  on: () => {},
  isDestroyed: () => false,
  getPosition: () => [origin.x, origin.y],
  setPosition: (x: number, y: number) => {
    origin = { x, y };
  },
  setBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    boundsSet.push(bounds);
    origin = { x: bounds.x, y: bounds.y };
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
  // Stubbed for the same reason as the rest of this mock: the module under
  // test imports it, and an export missing from a whole-module mock fails the
  // file at load rather than in the case that uses it.
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  shell: { openExternal: () => Promise.resolve() },
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

/** Main's show/hide/destroy listeners, so a case can fire one. */
const visibilityListeners: (() => void)[] = [];

mock.module("./main-window", () => ({
  // Only its existence is read: it is what decides whether a press is
  // dispatched straight into a renderer or has to build one first, and
  // whether a visibility change is the window being destroyed.
  current: () => (mainWindowOpen ? {} : null),
  dispatchToMain: (command: VellumCommand) => {
    dispatched.push(command);
  },
  ensureVisible: () => {
    windowsRaised += 1;
    return Promise.resolve();
  },
  onMainWindowVisibilityChange: (listener: () => void) => {
    visibilityListeners.push(listener);
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

/**
 * The evaluated flags the app's window writes into settings, which is where
 * main reads both the surface's own flag and Watch's. Mutable, because the
 * whole point of reading them from settings is that they land after launch and
 * can move again while the app runs.
 */
let flags: Record<string, boolean> = { "companion-surface": true };

/** Main's `featureFlags` listeners, so a case can fire a targeting change. */
const flagListeners: (() => void)[] = [];

mock.module("@vellumai/electron-desktop/settings", () => ({
  readSetting: () => flags,
  onSettingChange: (_key: string, listener: () => void) => {
    flagListeners.push(listener);
    return () => {};
  },
}));

/**
 * The size the store holds for each axis.
 *
 * A record rather than one answer for both, because the two axes are read and
 * written separately and a mock that ignored the axis would let a resize apply
 * a pick to the wrong half of the surface without failing anything.
 */
const sizes: Record<CompanionSizeAxis, CompanionSize> = {
  avatar: "small",
  options: "small",
};

mock.module("@vellumai/electron-desktop/window-state", () => ({
  readCompanionSize: (axis: CompanionSizeAxis) => sizes[axis],
  readCompanionHidden: () => false,
  writeCompanionSize: (axis: CompanionSizeAxis, size: CompanionSize) => {
    sizes[axis] = size;
  },
  writeCompanionHidden: () => {},
  // Stubbed rather than omitted, like every other export here: the module
  // under test imports these, and one missing from a whole-module mock is a
  // load-time failure for the file rather than a failing case.
  readCompanionIntroSeen: () => true,
  writeCompanionIntroSeen: () => {},
}));

// Dynamic, so the mocks above are installed before the module graph loads:
// static imports hoist above them.
const {
  growthFor,
  cardGrowthFor,
  avatarOffsetFor,
  companionContextMenuTemplate,
  geometryFor,
  placeCanvas,
  callOnUpdate,
  introOnAdvance,
  setCompanionSurfaceSize,
  shouldShowCompanionSurface,
  installCompanionWindow,
} = await import("./companion-window");

installCompanionWindow();

/**
 * The module holds the canvas it was last asked for, so a case that picks a
 * size leaves it there. Put both axes back and forget the window's position.
 */
beforeEach(() => {
  sizes.avatar = "small";
  sizes.options = "small";
  setCompanionSurfaceSize("avatar", "small");
  origin = { x: 0, y: 0 };
  boundsSet.length = 0;
});

/** Put a set of evaluated flags in settings and tell main they changed. */
const setFlags = (next: Record<string, boolean>): void => {
  flags = next;
  for (const listener of [...flagListeners]) {
    listener();
  }
};

/** Fire main's visibility listeners, as show, hide, and destroy all do. */
const fireVisibilityChange = (): void => {
  for (const listener of [...visibilityListeners]) {
    listener();
  }
};

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
 * The size the placement cases are written against, which is the one the
 * renderer's layout is authored at. Every other size is the same arithmetic
 * scaled, which `geometryFor` has its own cases for.
 */
const GEOMETRY = geometryFor("small", "small");
const RISE_ABOVE = GEOMETRY.riseAbove;
const DROP_BELOW = GEOMETRY.dropBelow;

/** A creature far larger than the controls beside it, and the reverse. */
const BIG_CREATURE = geometryFor("huge", "small");
const BIG_OPTIONS = geometryFor("small", "huge");

/**
 * The part of the base reach the geometry does not publish: the pill's widest.
 * Bound to the contract for the cases that are about it rather than the sum.
 */
const MAX_PILL_WIDTH = COMPANION_BASE_MAX_PILL_WIDTH;

/**
 * The growth direction is the only rule in the companion window worth testing
 * without a window server: everything else is Electron plumbing. It decides
 * which way the pill unfurls out of the avatar, and getting it wrong runs the
 * controls off the side of the display.
 */

// A 1440pt display with no menu-bar offset, which keeps the arithmetic in the
// cases readable.
const DISPLAY = { x: 0, width: 1440 };

// The clearance the pill needs on the side it grows into, measured from the
// avatar's centre the way the room on each side is: the avatar's half box, the
// gap, then the widest body.
const NEEDED = GEOMETRY.maxReach;

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
    expect(growthFor(DISPLAY.width - NEEDED + 1, DISPLAY, GEOMETRY)).toBe(
      "left",
    );
  });

  /**
   * The gap and the avatar's half box are part of the clearance, not slack the
   * pill can be squeezed into. A test measured against the body alone would
   * pass with the pill's leading edge already off the display.
   */
  test("counts the gap and the half box as room the pill needs", () => {
    expect(growthFor(DISPLAY.width - MAX_PILL_WIDTH, DISPLAY, GEOMETRY)).toBe(
      "left",
    );
  });

  /**
   * The room is measured from the avatar's centre while the pill starts at the
   * avatar's edge, so the half box is the difference between fitting and
   * clipping. 340pt on the right clears the gap and the widest body and still
   * cuts the controls off.
   */
  test("flips when only the avatar's half box is missing on the right", () => {
    expect(growthFor(DISPLAY.width - 340, DISPLAY, GEOMETRY)).toBe("left");
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
    expect(
      centreOf(placeCanvas({ x: 700, y: 500 }, WORK_AREA, GEOMETRY)),
    ).toEqual({
      x: 700,
      y: 500,
    });
  });

  test("holds the avatar at the right edge rather than past it", () => {
    expect(
      centreOf(placeCanvas({ x: 9000, y: 500 }, WORK_AREA, GEOMETRY)).x,
    ).toBe(1440 - 22);
  });

  test("holds the avatar at the left edge rather than past it", () => {
    expect(
      centreOf(placeCanvas({ x: -9000, y: 500 }, WORK_AREA, GEOMETRY)).x,
    ).toBe(22);
  });

  test("holds the avatar at the bottom edge rather than past it", () => {
    expect(
      centreOf(placeCanvas({ x: 700, y: 9000 }, WORK_AREA, GEOMETRY)).y,
    ).toBe(900 - 22);
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
    expect(
      centreOf(placeCanvas({ x: 99999, y: 500 }, secondary, GEOMETRY)).x,
    ).toBe(1440 + 1920 - 22);
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
      expect(
        placeCanvas({ x: 700, y }, WORK_AREA, GEOMETRY).origin.y,
      ).toBeGreaterThanOrEqual(WORK_AREA.y);
    }
  });

  /**
   * The bug as the user met it: the avatar stopped hundreds of points short of
   * the top for no visible reason. It was the canvas's upper half, which the
   * old symmetric canvas spent on a card that had nowhere to grow.
   */
  test("brings the avatar within a shadow's width of the top", () => {
    const centre = centreOf(
      placeCanvas({ x: 700, y: -9000 }, WORK_AREA, GEOMETRY),
    );
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
    expect(cardGrowthFor(WORK_AREA.y + RISE_ABOVE, WORK_AREA, GEOMETRY)).toBe(
      "up",
    );
    expect(
      cardGrowthFor(WORK_AREA.y + RISE_ABOVE - 1, WORK_AREA, GEOMETRY),
    ).toBe("down");
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
    const next = callOnUpdate(running, {
      phase: "speaking",
      detail: "Reading",
    });
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
 * The introduction runs once in an install's life, so the rule that walks it is
 * worth stating as cases: there is no second chance to get it right for a user,
 * and every wrong answer here is either a run that repeats or one that ends
 * before it has said anything.
 */
describe("introOnAdvance", () => {
  test("walks to the next beat", () => {
    expect(introOnAdvance("meet", "next")).toBe("talk");
    expect(introOnAdvance("talk", "next")).toBe("type");
    expect(introOnAdvance("type", "next")).toBe("menu");
  });

  // Past the last beat there is no next one, and `null` is what main reads as
  // the run being over and worth recording.
  test("falls off the end of the last beat", () => {
    expect(introOnAdvance("menu", "next")).toBe(null);
  });

  test("dismiss ends the run from any beat", () => {
    expect(introOnAdvance("meet", "dismiss")).toBe(null);
    expect(introOnAdvance("type", "dismiss")).toBe(null);
  });

  // A press that arrives after the run is already over. The renderer can be a
  // beat behind main, so this is reachable by a real double-press on the last
  // beat rather than only in theory.
  test("stays over once it is over", () => {
    expect(introOnAdvance(null, "next")).toBe(null);
    expect(introOnAdvance(null, "dismiss")).toBe(null);
  });
});

/**
 * The surface is the most conspicuous thing this app puts on screen, so what
 * decides whether it appears is worth stating as cases: an assistant to draw is
 * a floor and the tray preference is a veto.
 */
describe("shouldShowCompanionSurface", () => {
  test("shows once there is an assistant and it has not been hidden", () => {
    expect(shouldShowCompanionSurface(true, false)).toBe(true);
  });

  test("honours the tray preference even with an assistant to draw", () => {
    expect(shouldShowCompanionSurface(true, true)).toBe(false);
  });

  // The state every launch starts in, and the one a sign-out returns to: main's
  // avatar cache is filled by the app's window, and until it has there is no
  // creature, no name and no conversation for the pill to carry.
  test("stays away while there is no assistant to be", () => {
    expect(shouldShowCompanionSurface(false, false)).toBe(false);
  });

  // Signing out must not also clear the preference, so this pair stays
  // distinct from the one above rather than collapsing into it.
  test("stays away with no assistant even when not hidden", () => {
    expect(shouldShowCompanionSurface(false, true)).toBe(false);
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
  /**
   * What the width is actually for: the avatar's half box, the gap the pill
   * hangs off it by, and the widest the pill draws, on both sides so main can
   * flip the direction without resizing the window, plus the shadow's room.
   *
   * Stated as the numbers each step comes to rather than as the sum again. Each
   * one is a canvas that was looked at, and a formula repeated here would pass
   * against any change to the formula it repeats.
   */
  test("holds the pill's whole reach on both sides of the avatar", () => {
    const canvases: Record<
      CompanionSize,
      { maxReach: number; canvasWidth: number; canvasHeight: number }
    > = {
      small: { maxReach: 350, canvasWidth: 748, canvasHeight: 338 },
      medium: { maxReach: 525, canvasWidth: 1122, canvasHeight: 507 },
      large: { maxReach: 700, canvasWidth: 1496, canvasHeight: 676 },
      huge: { maxReach: 875, canvasWidth: 1870, canvasHeight: 845 },
      ridiculous: { maxReach: 1750, canvasWidth: 3740, canvasHeight: 1690 },
    };
    for (const size of COMPANION_SIZES) {
      const { maxReach, canvasWidth, canvasHeight } = geometryFor(size, size);
      expect({ maxReach, canvasWidth, canvasHeight }).toEqual(canvases[size]);
    }
  });

  /**
   * The creature's box is the avatar axis's answer and nothing else's. It is
   * what main clamps by, so a pill size leaking into it would move where the
   * mascot is allowed to sit.
   */
  test("takes the creature's box from the avatar axis alone", () => {
    for (const options of COMPANION_SIZES) {
      expect(geometryFor("large", options).avatarBox).toBe(
        COMPANION_SIZE_BOXES.large,
      );
    }
  });

  /**
   * Everything beside the creature is the options axis's answer, starting with
   * the pill's own box.
   */
  test("takes the pill's box from the options axis alone", () => {
    for (const avatar of COMPANION_SIZES) {
      expect(geometryFor(avatar, "large").optionsBox).toBe(
        COMPANION_SIZE_BOXES.large,
      );
    }
  });

  /**
   * The two-box distances are the one-box ones wherever there is only one size,
   * which is what makes the second axis a widening rather than a second
   * geometry to keep in step.
   */
  test("reduces to the single-scale canvas when the axes agree", () => {
    // The two sides at the base size, which the whole layout is authored
    // around: the creature and its shadow below, the card's height above.
    expect(
      companionNearEdgeFor(
        COMPANION_BASE_AVATAR_BOX,
        COMPANION_BASE_AVATAR_BOX,
      ),
    ).toBe(46);
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size, size);
      const scale = companionScaleFor(geometry.avatarBox);
      expect(geometry.dropBelow).toBe(46 * scale);
      expect(geometry.riseAbove).toBe(292 * scale);
    }
  });

  test("grows monotonically through the named steps", () => {
    const boxes = COMPANION_SIZES.map(
      (size) => geometryFor(size, size).avatarBox,
    );
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
      const geometry = geometryFor(size, size);
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
      const geometry = geometryFor(size, size);
      expect(geometry.dropBelow).toBeLessThan(geometry.riseAbove);
      expect(geometry.riseAbove + geometry.dropBelow).toBe(
        geometry.canvasHeight,
      );
    }
  });
});

/**
 * The canvas when the creature and the controls are sized apart, which is the
 * shape the two axes exist for.
 *
 * Both sides of the avatar are sized for whichever card direction needs more,
 * so main can still flip the direction by moving the window rather than
 * rebuilding it. The cost is a few transparent points of slack in the direction
 * that needed less, which is what the stated canvases carry: a side short by a
 * point clips the pill or the card.
 */
describe("geometryFor with the two axes apart", () => {
  const MIXED = [BIG_CREATURE, BIG_OPTIONS];

  test("spends the whole canvas on the two sides of the avatar", () => {
    for (const geometry of MIXED) {
      expect(geometry.riseAbove + geometry.dropBelow).toBe(
        geometry.canvasHeight,
      );
      expect(geometry.dropBelow).toBeLessThan(geometry.riseAbove);
      expect(Number.isInteger(geometry.canvasHeight)).toBe(true);
    }
  });

  /**
   * Each mix as the canvas it comes to rather than as the formula repeated,
   * since a formula restated here would pass against any change to the formula
   * it restates.
   *
   * The width is where the gap rule shows: the gap is breathing room, so the
   * smaller of the two boxes decides how much of it there is, and the creature
   * below takes the base gap rather than the chasm its own scale would ask for,
   * which would put its reach at 401. The two heights are the two sides of the
   * avatar: the near edge clears the creature's bottom and the pill's top
   * alike, and the far edge clears the card growing either way.
   */
  test("holds the pill, the card and the creature at each mix", () => {
    // An enormous creature's half box, the base gap, and a base-width pill.
    expect(BIG_CREATURE).toEqual({
      avatarBox: 110,
      optionsBox: 44,
      maxReach: 383,
      canvasWidth: 886,
      riseAbove: 361,
      dropBelow: 115,
      canvasHeight: 476,
    });
    // A base half box, the same gap, and a pill two and a half times as wide.
    expect(BIG_OPTIONS).toEqual({
      avatarBox: 44,
      optionsBox: 110,
      maxReach: 824,
      canvasWidth: 1768,
      riseAbove: 763,
      dropBelow: 148,
      canvasHeight: 911,
    });
  });

  test("flips the pill at the reach the options size asks for", () => {
    expect(
      growthFor(DISPLAY.width - BIG_CREATURE.maxReach, DISPLAY, BIG_CREATURE),
    ).toBe("right");
    expect(
      growthFor(
        DISPLAY.width - BIG_CREATURE.maxReach + 1,
        DISPLAY,
        BIG_CREATURE,
      ),
    ).toBe("left");
  });

  /**
   * A display too narrow for the pill either way still grows the designed way,
   * and an enormous options size beside a small creature is how a 1440pt
   * display gets there.
   */
  test("still grows the designed way where neither side can hold the pill", () => {
    expect(
      growthFor(DISPLAY.width - BIG_OPTIONS.maxReach + 1, DISPLAY, BIG_OPTIONS),
    ).toBe("right");
  });
});

/**
 * The menu a right-click on the surface pops, which is where a user actually
 * reaches for the two things a floating avatar offers: a different size, and
 * making it go away.
 *
 * The template rather than the menu: a menu is a native window, and what is
 * worth stating is what this menu adds to the size pickers it shares with the
 * tray, which is where they sit and the item that takes the surface away. The
 * pickers themselves have their own suite in `companion-menu.test.ts`.
 */
describe("companionContextMenuTemplate", () => {
  /** Only what a menu item is read for here. */
  type MenuItem = {
    label?: string;
    type?: string;
    click?: () => void;
  };

  const build = (
    current: Record<CompanionSizeAxis, CompanionSize> = {
      avatar: "small",
      options: "small",
    },
  ) => {
    let hidden = false;
    const items = companionContextMenuTemplate(current, {
      setSize: () => {},
      hide: () => {
        hidden = true;
      },
    }) as MenuItem[];
    return { items, wasHidden: () => hidden };
  };

  test("closes with a separator and the way out, past the headings", () => {
    expect(
      build()
        .items.map((item) => item.label ?? item.type)
        .slice(2),
    ).toEqual(["separator", "Hide Companion"]);
  });

  /**
   * The headings are the shared builder's output rather than a second set of
   * items, so the surface's menu and the tray's cannot describe the same choice
   * differently. Compared as data, since the clicks are closures.
   */
  test("draws its two headings from the builder the tray reads", () => {
    const current = { avatar: "ridiculous", options: "medium" } as const;
    expect(JSON.stringify(build(current).items.slice(0, 2))).toBe(
      JSON.stringify(companionSizeSubmenus(current, () => {})),
    );
  });

  test("the last item takes the surface away", () => {
    const menu = build();
    menu.items[3]?.click?.();
    expect(menu.wasHidden()).toBe(true);
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
  const LARGE = geometryFor("large", "large");

  /**
   * One size on both axes, then the two mixes. The clamp binds on the creature,
   * which is the avatar axis's answer, so an enormous pill beside a small
   * creature must not hold that creature away from the edge, and an enormous
   * creature beside a small pill must be held by its own whole box.
   */
  const SIZED = [LARGE, BIG_CREATURE, BIG_OPTIONS];

  test("holds the avatar at the edges by its own box, not the canvas", () => {
    for (const geometry of SIZED) {
      const placed = placeCanvas({ x: 9000, y: 500 }, WORK_AREA, geometry);
      expect(centreOf(placed, geometry).x).toBe(
        WORK_AREA.x + WORK_AREA.width - geometry.avatarBox / 2,
      );
    }
  });

  test("still never asks for an origin above the work area", () => {
    for (const geometry of SIZED) {
      for (const y of [-9000, 0, 25, 100, 400]) {
        expect(
          placeCanvas({ x: 700, y }, WORK_AREA, geometry).origin.y,
        ).toBeGreaterThanOrEqual(WORK_AREA.y);
      }
    }
  });

  /**
   * The gap left at the top is the shadow's room, so it scales with everything
   * else. Bigger is a worse ceiling than `small` and still nothing like the
   * canvas half-height the bug was.
   */
  test("reaches the top, short by the near edge its own canvas asks for", () => {
    for (const geometry of SIZED) {
      const centre = centreOf(
        placeCanvas({ x: 700, y: -9000 }, WORK_AREA, geometry),
        geometry,
      );
      expect(centre.y).toBe(WORK_AREA.y + geometry.dropBelow);
      expect(centre.y).toBeLessThan(WORK_AREA.y + geometry.riseAbove);
    }
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
 * A size pick, which is the one moment the canvas is rebuilt.
 *
 * What has to survive it is the avatar, not the window. They are not the same
 * point and the difference is most of the canvas, so a rebuild that kept the
 * origin would slide the creature by the change in its offset and walk the
 * thing the user was enlarging off across the desktop.
 */
describe("setCompanionSurfaceSize", () => {
  /**
   * Where the avatar is parked for the pick: low enough on the display that the
   * card grows upward at both sizes, and far enough from either side that
   * nothing is clamped. So the only thing that can move the creature is the
   * resize itself.
   */
  const CENTRE = { x: 722, y: 800 };

  test("rebuilds the canvas around the avatar rather than the origin", () => {
    // Parked by the path a drag takes. The first delta runs past every edge, so
    // it lands on a clamp whatever the window was doing beforehand; the second
    // puts the avatar on `CENTRE`.
    send("vellum:companion:moveBy", -100000, -100000);
    send("vellum:companion:moveBy", 700, 754);
    expect({
      x: origin.x + GEOMETRY.canvasWidth / 2,
      y: origin.y + RISE_ABOVE,
    }).toEqual(CENTRE);

    setCompanionSurfaceSize("options", "huge");

    // One call rather than a size and then a position: two would put the window
    // at the new size in the old place for a frame.
    expect(boundsSet).toHaveLength(1);
    const bounds = boundsSet[0];
    expect({ width: bounds?.width, height: bounds?.height }).toEqual({
      width: BIG_OPTIONS.canvasWidth,
      height: BIG_OPTIONS.canvasHeight,
    });
    // The avatar read back out of the new canvas the way main reads it: half
    // the width across, and the offset the card's direction asks for down.
    expect({
      x: (bounds?.x ?? 0) + BIG_OPTIONS.canvasWidth / 2,
      y: (bounds?.y ?? 0) + BIG_OPTIONS.riseAbove,
    }).toEqual(CENTRE);
  });

  test("leaves the other axis where it was", () => {
    setCompanionSurfaceSize("options", "huge");
    expect(sizes).toEqual({ avatar: "small", options: "huge" });
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
   * A publisher that omits the field, which the schema defaults. Absence is
   * the answer "no session", never a drawn indicator over a machine nobody is
   * watching.
   */
  test("reads a context with no watching at all as no session", () => {
    send("vellum:companion:setContext", context());
    expect(state().watching).toBe(false);
  });

  /**
   * The session's screen reads, which the surface draws one flare per. Main
   * holds them for the same reason it holds the flag: the surface's renderer
   * reloads, and it has no other way of knowing what a session has taken.
   */
  test("carries the capture count into pushed state", () => {
    send(
      "vellum:companion:setContext",
      context({ watching: true, captureCount: 3 }),
    );
    expect(state().captureCount).toBe(3);
  });

  /**
   * A publisher that reports no count has taken no reads this surface can
   * vouch for, the same bargain absence is given everywhere else here.
   */
  test("reads a context with no capture count as no captures", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(state().captureCount).toBe(0);
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

/**
 * The summary a finished session leaves behind: a fact main holds and an answer
 * it forwards.
 *
 * The one press on this surface that may raise the app, and only on a yes.
 * Watch is kept behind the user's work because that work is the session's
 * subject; by the time this is pressed the session is over and the report is a
 * thing to read.
 */
describe("the watch summary main relays", () => {
  beforeEach(() => {
    dispatched.length = 0;
    windowsRaised = 0;
    mainWindowOpen = true;
    send("vellum:companion:setContext", context());
    pushes.length = 0;
  });

  test("carries the summary phase from the published context into pushed state", () => {
    send("vellum:companion:setContext", context({ watchRetro: "pending" }));
    expect(state().watchRetro).toBe("pending");
    send("vellum:companion:setContext", context({ watchRetro: "ready" }));
    expect(state().watchRetro).toBe("ready");
  });

  // Every value it can hold is a claim that something is happening, so absence
  // is the only way to say nothing is and has to survive the trip.
  test("a context with no summary reports none", () => {
    send("vellum:companion:setContext", context());
    expect(state().watchRetro).toBeUndefined();
  });

  // The window comes forward first and the navigation follows it, so the press
  // lands a microtask later: dispatching ahead of the show would navigate a
  // page the user is not looking at yet.
  test("raises the app on a yes, since the report is the thing to read", async () => {
    send("vellum:companion:answerWatchRetro", true);
    expect(windowsRaised).toBe(1);

    await Promise.resolve();

    expect(dispatched).toEqual([{ kind: "answerWatchRetro", open: true }]);
  });

  /**
   * A dismissal still travels: the window that ran the retrospective is the one
   * holding the question, and an answer kept on this surface would be a
   * question that gets asked again on the next push.
   */
  test("forwards a no without dragging the app over the user's work", () => {
    send("vellum:companion:answerWatchRetro", false);
    expect(dispatched).toEqual([{ kind: "answerWatchRetro", open: false }]);
    expect(windowsRaised).toBe(0);
  });
});

/**
 * The app's window is destroyed while this surface stays open.
 *
 * The socket and the microphone go down with the renderer, and nothing is left
 * to publish `watching: false`. A destroyed document does not reliably run
 * React cleanup, so main has to give the claim up itself or the pill keeps
 * drawing a capture indicator over a machine nothing is capturing.
 */
describe("the watch flag when the app's window goes away", () => {
  test("is given up when the window is destroyed", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(state().watching).toBe(true);

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(state().watching).toBe(false);
  });

  test("publishes the change, so the open surface redraws", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    const before = pushes.length;

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(pushes.length).toBeGreaterThan(before);
    expect(pushes.at(-1)?.watching).toBe(false);
  });

  /**
   * Hiding leaves the renderer alive and its session running. Clearing on any
   * visibility change would put the indicator out under a session that is
   * still reading the screen, which is the same failure inverted.
   */
  test("survives the window merely being hidden", () => {
    send("vellum:companion:setContext", context({ watching: true }));

    mainWindowOpen = true;
    fireVisibilityChange();

    expect(state().watching).toBe(true);
  });

  /**
   * The tail and the name are a record of what was said and this surface is
   * still where it is read, the same bargain `clearCompanionWorking` makes.
   */
  test("leaves the conversation and the name standing", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        turns: [{ role: "user", text: "hello" }],
      }),
    );

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(state().assistantName).toBe("Ziggy");
    expect(state().turns).toEqual([{ role: "user", text: "hello" }]);
  });

  test("says nothing when no session was running", () => {
    send("vellum:companion:setContext", context({ watching: false }));
    const before = pushes.length;

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(pushes.length).toBe(before);
  });
});

/**
 * The Watch flag, from settings to the surface.
 *
 * The floating window has no auth and no flag store that ever settles, so main
 * is the only side of this surface holding a real evaluation. What a case can
 * hold is that the evaluation reaches the pushed state, that it keeps reaching
 * it after a targeting change, and that every answer which is not a positive
 * one arrives as off.
 */
describe("the Watch flag on the pushed state", () => {
  test("is off when the flags have not arrived yet", () => {
    setFlags({});

    expect(state().watchEnabled).toBe(false);
  });

  test("is off when the flag was never provisioned", () => {
    setFlags({ "companion-surface": true });

    expect(state().watchEnabled).toBe(false);
  });

  test("is off when the evaluation says so", () => {
    setFlags({ "companion-surface": true, teach: false });

    expect(state().watchEnabled).toBe(false);
  });

  test("is on when the evaluation says so", () => {
    setFlags({ "companion-surface": true, teach: true });

    expect(state().watchEnabled).toBe(true);
  });

  /**
   * The evaluation lands after launch: the app's window has to sign in and
   * fetch it first. A surface already on screen has to hear the answer without
   * waiting for something else to move the state.
   */
  test("is pushed to the open surface when it changes", () => {
    setFlags({ "companion-surface": true });
    const before = pushes.length;

    setFlags({ "companion-surface": true, teach: true });

    expect(pushes.length).toBeGreaterThan(before);
    expect(pushes.at(-1)?.watchEnabled).toBe(true);
  });

  test("is pushed again when the answer is taken away", () => {
    setFlags({ "companion-surface": true, teach: true });
    const before = pushes.length;

    setFlags({ "companion-surface": true, teach: false });

    expect(pushes.length).toBeGreaterThan(before);
    expect(pushes.at(-1)?.watchEnabled).toBe(false);
  });
});
