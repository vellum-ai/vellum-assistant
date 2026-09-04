import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_MAX_PILL_WIDTH,
  VOICE_START_REQUEST_TTL_MS,
  COMPANION_SIZES,
  companionBoxFor,
  companionCardSideFor,
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

/** Whether the app's window is on screen, as opposed to put away or minimised. */
let mainWindowVisible = true;

/**
 * Whether the surface's window exists. Closed by the tray and by the assistant
 * going away, and opened again by the same two, so a case can open one over an
 * app that is already in front. Reset before each case.
 */
let companionOpen = true;

/**
 * The app's window, as far as this module reads it: whether it exists and
 * whether it is showing. One object, so a focus event can name it by identity.
 */
const mainWindow = {
  isDestroyed: () => false,
  isVisible: () => mainWindowVisible,
};

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
  close: () => {
    companionOpen = false;
  },
  on: () => {},
  isDestroyed: () => false,
  /** Whether the surface is on screen: off it while the app is in front. */
  visible: true,
  hide: () => {
    surface.visible = false;
  },
  showInactive: () => {
    surface.visible = true;
  },
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

/**
 * The system's "Reduce motion", which decides whether a call moves the surface
 * at once or glides it. On by default so every case about *where* the surface
 * goes reads its answer synchronously; the cases about the glide itself turn
 * it off.
 */
let reducedMotion = true;

/**
 * The display the window server answers for whatever point it is asked, the
 * one the surface is placed against. Mutable so a case can change the display
 * under a surface that is mid-move, as unplugging or rescaling one does.
 */
const NEAREST_DISPLAY = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
};
let nearestDisplay = NEAREST_DISPLAY;

/** Main's application listeners, so a case can bring the app forward. */
const appListeners: {
  event: string;
  listener: (...args: unknown[]) => void;
}[] = [];

/** Fire an application event main registered, as the OS would. */
const fireAppEvent = (event: string, ...args: unknown[]): void => {
  for (const entry of [...appListeners]) {
    if (entry.event === event) {
      entry.listener({}, ...args);
    }
  }
};

mock.module("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  systemPreferences: {
    getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }),
  },
  app: {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      appListeners.push({ event, listener });
    },
  },
  // Stubbed for the same reason as the rest of this mock: the module under
  // test imports it, and an export missing from a whole-module mock fails the
  // file at load rather than in the case that uses it.
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  shell: { openExternal: () => Promise.resolve() },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => nearestDisplay,
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    on: (event: string, listener: () => void) => {
      screenListeners.push({ event, listener });
    },
  },
}));

/** Main's display listeners, so a case can rearrange the displays. */
const screenListeners: { event: string; listener: () => void }[] = [];

/** Fire the display event main registered, as the window server would. */
const fireDisplayEvent = (event: string): void => {
  for (const entry of [...screenListeners]) {
    if (entry.event === event) {
      entry.listener();
    }
  }
};

/**
 * The displays the window server has, by id, for a session framing one of
 * them. Two by default, so a case can pick the one the surface is not on.
 */
let displays: {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}[] = [];

/**
 * Where the helper says a picked window is, or null when it is off screen.
 * The frame polls this; a case sets it and lets the poll run.
 */
let windowBounds: {
  x: number;
  y: number;
  width: number;
  height: number;
} | null = null;

/** Every window id the frame has asked the helper about, most recent last. */
const boundsAsked: number[] = [];

/** What the picker's list resolves to, and what a pressed row resolves to. */
const listedSources = {
  displays: [
    { kind: "display" as const, displayId: 1, index: 0, primary: true },
  ],
  tabs: [],
  windows: [],
};
let resolvedPick:
  | { kind: "display"; displayId: number }
  | { kind: "window"; windowId: number }
  | null = null;
const picksResolved: unknown[] = [];

// The desktop half of the picker asks a helper process, Chrome and the window
// server, none of which exist here. What this file holds is what main does
// with the answers: where it puts the frame, and what it dispatches.
/** The resolution itself, swappable so a case can hold one open. */
let resolvedPickAsync: (pick: unknown) => Promise<typeof resolvedPick> = async (
  pick,
) => {
  picksResolved.push(pick);
  return resolvedPick;
};

/** What the helper answers for a frame of a shared target, by the target. */
const framesAsked: unknown[] = [];
let capturedFrame: {
  jpegBase64: string;
  width: number;
  height: number;
} | null = { jpegBase64: "/9j/", width: 16, height: 9 };

mock.module("./companion-capture-sources", () => ({
  listCaptureSources: async () => listedSources,
  resolveCapturePick: (pick: unknown) => resolvedPickAsync(pick),
  captureTargetFrame: async (target: unknown) => {
    framesAsked.push(target);
    return capturedFrame;
  },
  windowBoundsFor: async (windowId: number) => {
    boundsAsked.push(windowId);
    return windowBounds;
  },
}));

mock.module("./ipc", () => ({
  on: register(listeners),
  handle: register(invocable),
}));

/** Main's show/hide/destroy listeners, so a case can fire one. */
const visibilityListeners: (() => void)[] = [];

mock.module("./main-window", () => ({
  // Its existence decides whether a press is dispatched straight into a
  // renderer or has to build one first, and whether a visibility change is the
  // window being destroyed; whether it is showing decides, with the app's
  // activation, whether the surface is on the screen.
  current: () => (mainWindowOpen ? mainWindow : null),
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

/**
 * The display's edge glow, which main opens for a watch session and closes
 * after it. Kept apart from the surface so a push to both is two sends on two
 * windows, and so a case can see the light come on and go out.
 */
type GlowWindow = {
  bounds: { x: number; y: number; width: number; height: number };
  closed: boolean;
  level: [string, number] | null;
  webContents: {
    send: (channel: string, state: CompanionSurfaceState) => void;
  };
  getBounds: () => { x: number; y: number; width: number; height: number };
  setBounds: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  setAlwaysOnTop: (flag: boolean, level: string, relative: number) => void;
  close: () => void;
  isDestroyed: () => boolean;
  on: () => void;
  /** Whether the frame is on screen: hidden while its window is not. */
  visible: boolean;
  hide: () => void;
  showInactive: () => void;
  isVisible: () => boolean;
};
let glow: GlowWindow | null = null;
const glowPushes: CompanionSurfaceState[] = [];

const openGlow = (options: {
  position?: { x: number; y: number } | (() => { x: number; y: number });
  width: number;
  height: number;
}): GlowWindow => {
  const at =
    typeof options.position === "function"
      ? options.position()
      : (options.position ?? { x: 0, y: 0 });
  const window: GlowWindow = {
    bounds: { ...at, width: options.width, height: options.height },
    closed: false,
    level: null,
    webContents: {
      send: (_channel, state) => {
        glowPushes.push(state);
      },
    },
    getBounds: () => window.bounds,
    setBounds: (bounds) => {
      window.bounds = bounds;
    },
    setAlwaysOnTop: (_flag, level, relative) => {
      window.level = [level, relative];
    },
    close: () => {
      window.closed = true;
      glow = null;
    },
    isDestroyed: () => false,
    on: () => {},
    visible: true,
    hide: () => {
      window.visible = false;
    },
    showInactive: () => {
      window.visible = true;
    },
    isVisible: () => window.visible,
  };
  glow = window;
  return window;
};

mock.module("@vellumai/electron-desktop/floating-window", () => ({
  createFloatingWindow: (options: {
    kind: string;
    width: number;
    height: number;
    position?: { x: number; y: number } | (() => { x: number; y: number });
  }) => {
    if (options.kind !== "companion") {
      return openGlow(options);
    }
    // Shown on creation, the way the real one is.
    companionOpen = true;
    surface.visible = true;
    return surface;
  },
  getFloatingWindow: (kind: string) =>
    kind === "companion" ? (companionOpen ? surface : null) : glow,
}));

mock.module("@vellumai/electron-desktop/avatar", () => ({
  getAvatarPng: () => null,
  getCharacter: () => null,
  getAccentHex: () => null,
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
  defaultAvatarCentre,
  geometryFor,
  placeCanvas,
  callOnUpdate,
  callSurfaceFor,
  COMPANION_DIAL_TIMEOUT_MS,
  COMPANION_GLIDE_MS,
  dialOnTalk,
  glideProgress,
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
  nearestDisplay = NEAREST_DISPLAY;
  boundsSet.length = 0;
  glow = null;
  glowPushes.length = 0;
  displays = [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    },
    {
      id: 2,
      bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
    },
  ];
  windowBounds = null;
  boundsAsked.length = 0;
  resolvedPick = null;
  picksResolved.length = 0;
  // The user is working somewhere else, with the app's window open behind
  // them: the state the surface exists for.
  mainWindowOpen = true;
  mainWindowVisible = true;
  companionOpen = true;
  fireAppEvent("did-resign-active");
  surface.visible = true;
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
 * The part of the base reach the geometry does not publish: the pill's widest,
 * at the options size {@link GEOMETRY} is drawn in. Bound to the contract for
 * the cases that are about it rather than the sum.
 */
const MAX_PILL_WIDTH =
  COMPANION_BASE_MAX_PILL_WIDTH * companionScaleFor(GEOMETRY.optionsBox);

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
   * clipping. Room enough for the gap and the widest body still cuts the
   * controls off.
   */
  test("flips when only the avatar's half box is missing on the right", () => {
    expect(
      growthFor(
        DISPLAY.width - (NEEDED - GEOMETRY.avatarBox / 2),
        DISPLAY,
        GEOMETRY,
      ),
    ).toBe("left");
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

describe("defaultAvatarCentre", () => {
  test("opens at the bottom centre of the work area", () => {
    const centre = defaultAvatarCentre(WORK_AREA, GEOMETRY);
    expect(centre.x).toBe(720);
    expect(centre.y).toBe(25 + 875 - 24 - GEOMETRY.avatarBox / 2);
  });

  test("centres on the display it is given, not the primary one", () => {
    const secondary = { x: 1440, y: 0, width: 2560, height: 1415 };
    expect(defaultAvatarCentre(secondary, GEOMETRY).x).toBe(1440 + 1280);
  });

  test("lands where placeCanvas leaves it alone", () => {
    const wanted = defaultAvatarCentre(WORK_AREA, GEOMETRY);
    expect(centreOf(placeCanvas(wanted, WORK_AREA, GEOMETRY))).toEqual(wanted);
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

describe("the dial", () => {
  test("starts on a press with no session on the surface", () => {
    expect(dialOnTalk(null)).toBe(true);
  });

  /**
   * The window that owns the session spends the press on the call the user is
   * in, so nothing is coming that a dial could wait for.
   */
  test("does not start over a running session", () => {
    expect(dialOnTalk({ ...START })).toBe(false);
  });

  /**
   * A dial that closed while its request could still become a session would
   * reopen on that session a moment later, so the bound outlives the request.
   */
  test("outlives the request it is drawn for", () => {
    expect(COMPANION_DIAL_TIMEOUT_MS).toBeGreaterThan(
      VOICE_START_REQUEST_TTL_MS,
    );
  });

  /**
   * The press that ends a dial takes the request back by a command the root
   * layout consumes, since the session's own controls are heard only where a
   * session is owned and a dial can be ended before any layout owns one.
   */
  test("ending it takes the request back through a command", () => {
    mainWindowOpen = true;
    dispatched.length = 0;
    send("vellum:companion:startVoice");
    dispatched.length = 0;

    send("vellum:voiceActivity:control", { action: "endSession" });

    expect(dispatched).toEqual([{ kind: "cancelVoiceStart" }]);
    expect(state().dialing).toBe(false);
  });

  test("an end with no dial takes nothing back", () => {
    mainWindowOpen = true;
    send("vellum:voiceActivity:end");
    dispatched.length = 0;

    send("vellum:voiceActivity:control", { action: "endSession" });

    expect(dispatched).toEqual([]);
  });
});

/**
 * When the surface is the call's rather than the pill: taken to the bottom of
 * the display, the creature standing beside it, the display's edge lit.
 */
describe("the call surface", () => {
  test("is the pill with nothing running", () => {
    expect(callSurfaceFor(null, false)).toBe(false);
  });

  test("is the call's from the dial, before any session answers", () => {
    expect(callSurfaceFor(null, true)).toBe(true);
  });

  test("is the call's for a running session", () => {
    expect(callSurfaceFor({ ...START }, false)).toBe(true);
  });
});

/**
 * The surface the call takes: the handlebar goes to the bottom centre of the
 * display from the dial until the call ends, and then the pill goes home.
 *
 * Under "Reduce motion", so each move lands in the same beat it is asked for.
 * These cases are about where the surface ends up, which is the same point
 * either way; how it gets there has cases of its own below.
 */
describe("the surface a call takes", () => {
  /** The screen the electron mock answers for, whatever point it is asked. */
  const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };
  const centre = (): { x: number; y: number } => ({
    x: origin.x + GEOMETRY.canvasWidth / 2,
    y: origin.y + avatarOffsetFor(state().cardGrowth, GEOMETRY),
  });
  const bottomCentre = defaultAvatarCentre(SCREEN, GEOMETRY);
  /** Somewhere the user parked the pill, away from where a call puts it. */
  const park = (): { x: number; y: number } => {
    send("vellum:companion:moveBy", 300 - centre().x, 200 - centre().y);
    return centre();
  };

  beforeEach(() => {
    mainWindowOpen = true;
    send("vellum:voiceActivity:end");
    send("vellum:voiceActivity:control", { action: "endSession" });
  });

  test("goes to the bottom centre of the display on the dial", () => {
    park();
    send("vellum:companion:startVoice");
    expect(centre()).toEqual(bottomCentre);
  });

  /**
   * A call is a microphone, not a screen: the frame around the display is
   * the watch session's, and a call alone leaves it dark.
   */
  test("does not light the display's edge", () => {
    send("vellum:companion:startVoice");
    send("vellum:voiceActivity:start", START);
    expect(glow).toBeNull();
    send("vellum:voiceActivity:end");
  });

  test("goes home once the call is over", () => {
    const home = park();
    send("vellum:companion:startVoice");
    send("vellum:voiceActivity:start", START);
    send("vellum:voiceActivity:end");
    expect(centre()).toEqual(home);
  });

  test("goes home when the dial is declined", () => {
    const home = park();
    send("vellum:companion:startVoice");
    send("vellum:voiceActivity:end");
    expect(centre()).toEqual(home);
  });

  test("goes home when the user ends the dial", () => {
    const home = park();
    send("vellum:companion:startVoice");
    send("vellum:voiceActivity:control", { action: "endSession" });
    expect(centre()).toEqual(home);
  });

  /**
   * The bottom centre is a default, not a pin: the user can drag the handlebar
   * for the length of the call, and it is the pill's home they go back to.
   */
  test("stays draggable for the call and still goes home after it", () => {
    const home = park();
    send("vellum:companion:startVoice");
    send("vellum:companion:moveBy", -200, -100);
    expect(centre()).not.toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
    expect(centre()).toEqual(home);
  });

  test("does not move again for a session answering a dial", () => {
    send("vellum:companion:startVoice");
    send("vellum:companion:moveBy", -200, -100);
    const dragged = centre();
    send("vellum:voiceActivity:start", START);
    expect(centre()).toEqual(dragged);
  });

  test("is the call's for a session started in the app, not only for a dial", () => {
    park();
    send("vellum:voiceActivity:start", START);
    expect(centre()).toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
  });
});

/**
 * How the surface gets there: a glide from where it rests to where the call
 * puts it, and back. Real timers, since the glide is stepped on one, so each
 * case waits the glide out rather than asserting on a beat of it.
 */
describe("the glide between the pill's home and the call's place", () => {
  const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };
  const centre = (): { x: number; y: number } => ({
    x: origin.x + GEOMETRY.canvasWidth / 2,
    y: origin.y + avatarOffsetFor(state().cardGrowth, GEOMETRY),
  });
  const bottomCentre = defaultAvatarCentre(SCREEN, GEOMETRY);
  const park = (): { x: number; y: number } => {
    send("vellum:companion:moveBy", 300 - centre().x, 200 - centre().y);
    return centre();
  };
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Long enough for a glide started just now to have landed. */
  const settle = (): Promise<void> => wait(COMPANION_GLIDE_MS + 80);
  /**
   * Early enough in a glide that it is certainly still in flight, with the
   * slack of most of its length for a slow machine, and late enough that at
   * least one frame of it has run.
   */
  const MID_FLIGHT_MS = COMPANION_GLIDE_MS / 4;
  const between = (
    point: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean =>
    point.y > Math.min(a.y, b.y) &&
    point.y < Math.max(a.y, b.y) &&
    point.x > Math.min(a.x, b.x) &&
    point.x < Math.max(a.x, b.x);

  beforeEach(() => {
    mainWindowOpen = true;
    reducedMotion = false;
  });

  /** Leave the surface at rest with no call on it, whatever the case did. */
  afterEach(async () => {
    send("vellum:voiceActivity:end");
    send("vellum:voiceActivity:control", { action: "endSession" });
    await settle();
    reducedMotion = true;
  });

  test("lands exactly on the call's place, over time rather than at once", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    expect(centre()).toEqual(home);
    await wait(MID_FLIGHT_MS);
    expect(between(centre(), home, bottomCentre)).toBe(true);
    await settle();
    expect(centre()).toEqual(bottomCentre);
  });

  test("goes home the same way once the call is over", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    await settle();
    send("vellum:voiceActivity:end");
    await wait(MID_FLIGHT_MS);
    expect(between(centre(), home, bottomCentre)).toBe(true);
    await settle();
    expect(centre()).toEqual(home);
  });

  test("moves at once under Reduce motion", () => {
    reducedMotion = true;
    const home = park();
    send("vellum:companion:startVoice");
    expect(centre()).toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
    expect(centre()).toEqual(home);
  });

  /**
   * The home is where the pill rested, not where the outbound glide had got
   * to when the call ended, and the outbound glide does not carry on
   * underneath the homeward one.
   */
  test("a call ending mid-flight sends the pill back to where it rested", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    await wait(MID_FLIGHT_MS);
    expect(centre()).not.toEqual(home);
    send("vellum:voiceActivity:end");
    await settle();
    expect(centre()).toEqual(home);
    await settle();
    expect(centre()).toEqual(home);
  });

  /**
   * A call that arrives while the pill is still on its way home reads its
   * home off the glide's destination rather than the point it has reached,
   * so the pill goes back to the same place after both calls.
   */
  test("a call arriving on the way home remembers that home", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    await settle();
    send("vellum:voiceActivity:end");
    await wait(MID_FLIGHT_MS);
    const passing = centre();
    expect(passing).not.toEqual(home);
    send("vellum:companion:startVoice");
    await settle();
    expect(centre()).toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
    await settle();
    expect(centre()).toEqual(home);
    expect(centre()).not.toEqual(passing);
  });

  test("a drag mid-flight wins over the glide", async () => {
    park();
    send("vellum:companion:startVoice");
    await wait(MID_FLIGHT_MS);
    const reached = centre();
    send("vellum:companion:moveBy", -60, -40);
    const dragged = centre();
    expect(dragged).toEqual({ x: reached.x - 60, y: reached.y - 40 });
    await settle();
    expect(centre()).toEqual(dragged);
  });

  /**
   * The canvas is rebuilt around where the avatar rests, and a glide in
   * flight rests where it is headed: the pick lands it there at once, in the
   * new canvas, and no frame of the old glide steps across the rebuilt one.
   */
  test("a size pick mid-flight lands the glide in the new canvas", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    await wait(MID_FLIGHT_MS);
    expect(between(centre(), home, bottomCentre)).toBe(true);
    setCompanionSurfaceSize("options", "huge");
    const bounds = boundsSet.at(-1);
    expect({ width: bounds?.width, height: bounds?.height }).toEqual({
      width: BIG_OPTIONS.canvasWidth,
      height: BIG_OPTIONS.canvasHeight,
    });
    // Read back out of the new canvas, the way main reads it.
    const centreInNewCanvas = (): { x: number; y: number } => ({
      x: origin.x + BIG_OPTIONS.canvasWidth / 2,
      y: origin.y + avatarOffsetFor(state().cardGrowth, BIG_OPTIONS),
    });
    expect(centreInNewCanvas()).toEqual(bottomCentre);
    // Still there a frame or more later, where the old glide would have been
    // passing through a point short of it.
    await wait(MID_FLIGHT_MS);
    expect(centreInNewCanvas()).toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
    await settle();
    expect(centreInNewCanvas()).toEqual(home);
  });

  /**
   * The landing is clamped against the display under the avatar when it
   * lands, not the one the glide was aimed at: a display that shrinks or goes
   * mid-flight cannot leave the pill off the edge of the one that is left.
   */
  test("lands inside the display under it at landing time", async () => {
    park();
    send("vellum:companion:startVoice");
    await wait(MID_FLIGHT_MS);
    const shrunk = { x: 0, y: 0, width: 1000, height: 600 };
    nearestDisplay = { bounds: shrunk, workArea: shrunk };
    await settle();
    const placed = placeCanvas(bottomCentre, shrunk, GEOMETRY);
    expect(centre()).toEqual({
      x: placed.origin.x + GEOMETRY.canvasWidth / 2,
      y: placed.origin.y + avatarOffsetFor(placed.cardGrowth, GEOMETRY),
    });
    expect(centre().y).toBeLessThanOrEqual(
      shrunk.height - GEOMETRY.avatarBox / 2,
    );
  });

  /**
   * The setting is read per move, not per frame: a glide already in flight
   * lands on its timetable, and the move after the toggle is the one that
   * happens at once.
   */
  test("Reduce motion turned on mid-flight applies from the next move", async () => {
    const home = park();
    send("vellum:companion:startVoice");
    await wait(MID_FLIGHT_MS);
    reducedMotion = true;
    expect(between(centre(), home, bottomCentre)).toBe(true);
    await settle();
    expect(centre()).toEqual(bottomCentre);
    send("vellum:voiceActivity:end");
    expect(centre()).toEqual(home);
  });
});

describe("glideProgress", () => {
  test("starts at the start and ends at the end", () => {
    expect(glideProgress(0)).toBe(0);
    expect(glideProgress(1)).toBe(1);
  });

  test("holds at the ends past them", () => {
    expect(glideProgress(-0.5)).toBe(0);
    expect(glideProgress(1.5)).toBe(1);
  });

  /** An ease-out: ahead of a straight line, and never going back. */
  test("eases out", () => {
    let last = 0;
    for (let t = 0.1; t < 1; t += 0.1) {
      const now = glideProgress(t);
      expect(now).toBeGreaterThan(t);
      expect(now).toBeGreaterThan(last);
      last = now;
    }
  });
});

/**
 * The display's edge, lit while a watch session reads it: the whole screen
 * says it is being read, the way a shared screen is framed.
 */
describe("the light a watch session puts on the display", () => {
  const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };

  beforeEach(() => {
    mainWindowOpen = true;
    send("vellum:companion:setContext", context({ watching: false }));
  });

  test("comes on with the session", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(glow).not.toBeNull();
    expect(glow?.bounds).toEqual(SCREEN);
  });

  test("sits under the surface", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    expect(glow?.level).toEqual(["floating", -1]);
  });

  test("is told what the surface is told", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    glowPushes.length = 0;
    send(
      "vellum:companion:setContext",
      context({ watching: true, captureCount: 2 }),
    );
    expect(glowPushes.at(-1)?.captureCount).toBe(2);
  });

  test("goes out with the session", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    send("vellum:companion:setContext", context({ watching: false }));
    expect(glow).toBeNull();
  });

  test("stays dark for a context that says nothing about a session", () => {
    send("vellum:companion:setContext", context({}));
    expect(glow).toBeNull();
  });

  /**
   * The window that owns the session is gone, so nothing is reading the
   * screen, whatever the last push said.
   */
  test("goes out when the window holding the session is destroyed", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    mainWindowOpen = false;
    fireVisibilityChange();
    expect(glow).toBeNull();
  });

  test("stays lit through a call", () => {
    send("vellum:companion:setContext", context({ watching: true }));
    send("vellum:companion:startVoice");
    send("vellum:voiceActivity:start", START);
    expect(glow).not.toBeNull();
    send("vellum:voiceActivity:end");
    expect(glow).not.toBeNull();
    send("vellum:companion:setContext", context({ watching: false }));
  });

  /**
   * A session started on a pick frames exactly what it reads. The display
   * by its id, wherever the surface happens to be; the window by its bounds,
   * asked of the helper and asked again as it moves.
   */
  test("frames the picked display rather than the surface's", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "display", displayId: 2 },
      }),
    );
    expect(glow?.bounds).toEqual({ x: 1440, y: 0, width: 1920, height: 1080 });
  });

  test("is placed again when the picked display changes shape", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "display", displayId: 2 },
      }),
    );
    displays[1] = {
      ...displays[1],
      bounds: { x: 1440, y: 0, width: 1080, height: 1920 },
    };
    fireDisplayEvent("display-metrics-changed");
    expect(glow?.bounds).toEqual({ x: 1440, y: 0, width: 1080, height: 1920 });
  });

  test("is placed again with the surface hidden", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "display", displayId: 2 },
      }),
    );
    companionOpen = false;
    displays[1] = {
      ...displays[1],
      bounds: { x: 1440, y: 0, width: 1080, height: 1920 },
    };
    fireDisplayEvent("display-metrics-changed");
    expect(glow?.bounds).toEqual({ x: 1440, y: 0, width: 1080, height: 1920 });
  });

  test("falls back to the surface's display for one that is gone", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "display", displayId: 99 },
      }),
    );
    expect(glow?.bounds).toEqual(SCREEN);
  });

  test("frames the picked window where the helper says it is", async () => {
    windowBounds = { x: 200, y: 120, width: 800, height: 600 };
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "window", windowId: 4242 },
      }),
    );
    await Bun.sleep(0);
    expect(boundsAsked).toEqual([4242]);
    expect(glow?.bounds).toEqual({ x: 200, y: 120, width: 800, height: 600 });
    send("vellum:companion:setContext", context({ watching: false }));
  });

  test("hides the frame while the picked window is off screen", async () => {
    windowBounds = { x: 200, y: 120, width: 800, height: 600 };
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "window", windowId: 4242 },
      }),
    );
    await Bun.sleep(0);
    expect(glow?.visible).toBe(true);
    // Minimized: the helper no longer lists it.
    windowBounds = null;
    await Bun.sleep(300);
    expect(glow).not.toBeNull();
    expect(glow?.visible).toBe(false);
    // And back.
    windowBounds = { x: 10, y: 20, width: 800, height: 600 };
    await Bun.sleep(300);
    expect(glow?.visible).toBe(true);
    expect(glow?.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    send("vellum:companion:setContext", context({ watching: false }));
  });

  test("stops asking after the picked window once the session ends", async () => {
    windowBounds = { x: 200, y: 120, width: 800, height: 600 };
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        captureTarget: { kind: "window", windowId: 4242 },
      }),
    );
    await Bun.sleep(0);
    send("vellum:companion:setContext", context({ watching: false }));
    const asked = boundsAsked.length;
    await Bun.sleep(300);
    expect(boundsAsked.length).toBe(asked);
    expect(glow).toBeNull();
  });

  test("carries the target and whether one may be picked to the surface", () => {
    send(
      "vellum:companion:setContext",
      context({
        watching: true,
        watchTargets: true,
        captureTarget: { kind: "window", windowId: 7 },
      }),
    );
    expect(state().captureTarget).toEqual({ kind: "window", windowId: 7 });
    expect(state().watchTargets).toBe(true);
    send("vellum:companion:setContext", context({}));
    expect(state().captureTarget).toBeUndefined();
    expect(state().watchTargets).toBe(false);
  });
});

/**
 * Teach's picker, from main's side: the list it draws, and the pick that
 * comes back on the toggle channel as the session's target.
 */
describe("the picker behind Teach", () => {
  beforeEach(() => {
    mainWindowOpen = true;
    dispatched.length = 0;
  });

  test("lists what a session could read on demand", async () => {
    const list = invocable.get("vellum:companion:listCaptureSources");
    expect(list).toBeDefined();
    expect(await list?.([])).toEqual(listedSources);
  });

  test("a press with no pick is the toggle it always was", () => {
    send("vellum:companion:toggleWatch");
    expect(dispatched.at(-1)).toEqual({ kind: "toggleWatch" });
    expect(picksResolved).toHaveLength(0);
  });

  test("a pick rides the toggle to the window holding the session", async () => {
    resolvedPick = { kind: "window", windowId: 4242 };
    send("vellum:companion:toggleWatch", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 2,
    });
    await Bun.sleep(0);
    expect(picksResolved).toEqual([
      { kind: "tab", chromeWindowId: 3, tabIndex: 2 },
    ]);
    expect(dispatched.at(-1)).toEqual({
      kind: "toggleWatch",
      target: { kind: "window", windowId: 4242 },
    });
  });

  /**
   * Only the latest pick may start anything. A slow resolution (the first
   * one waits on the Automation prompt) outlived by a second pick would
   * otherwise dispatch beside it: two toggles, one ending what the other
   * started.
   */
  test("a pick superseded by a later one dispatches nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    resolvedPick = { kind: "window", windowId: 1 };
    const slow = resolvedPickAsync;
    resolvedPickAsync = async () => {
      await gate;
      return { kind: "window", windowId: 1 };
    };
    send("vellum:companion:toggleWatch", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 1,
    });
    resolvedPickAsync = slow;
    resolvedPick = { kind: "window", windowId: 2 };
    send("vellum:companion:toggleWatch", { kind: "window", windowId: 2 });
    await Bun.sleep(0);
    release();
    await Bun.sleep(0);
    expect(dispatched).toEqual([
      { kind: "toggleWatch", target: { kind: "window", windowId: 2 } },
    ]);
  });

  test("reopening the picker or ending the call supersedes a pending pick", async () => {
    for (const supersede of ["list", "end"] as const) {
      dispatched.length = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = resolvedPickAsync;
      resolvedPickAsync = async () => {
        await gate;
        return { kind: "window", windowId: 1 };
      };
      send("vellum:companion:toggleWatch", {
        kind: "tab",
        chromeWindowId: 3,
        tabIndex: 1,
      });
      resolvedPickAsync = slow;
      if (supersede === "list") {
        await invocable.get("vellum:companion:listCaptureSources")?.([]);
      } else {
        send("vellum:companion:startVoice");
        send("vellum:voiceActivity:start", START);
        send("vellum:voiceActivity:end");
      }
      release();
      await Bun.sleep(0);
      expect(dispatched.filter((c) => c.kind === "toggleWatch")).toEqual([]);
    }
  });

  test("a dial ending unanswered supersedes a pending pick", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = resolvedPickAsync;
    resolvedPickAsync = async () => {
      await gate;
      return { kind: "window", windowId: 1 };
    };
    send("vellum:companion:startVoice");
    send("vellum:companion:toggleWatch", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 1,
    });
    resolvedPickAsync = slow;
    // The window asked for a session says no: the dial ends with no call.
    send("vellum:voiceActivity:end");
    release();
    await Bun.sleep(0);
    expect(dispatched.filter((c) => c.kind === "toggleWatch")).toEqual([]);
  });

  test("a press with no pick supersedes a pending one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = resolvedPickAsync;
    resolvedPickAsync = async () => {
      await gate;
      return { kind: "window", windowId: 1 };
    };
    send("vellum:companion:toggleWatch", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 1,
    });
    resolvedPickAsync = slow;
    send("vellum:companion:toggleWatch");
    release();
    await Bun.sleep(0);
    expect(dispatched).toEqual([{ kind: "toggleWatch" }]);
  });

  test("a pick that resolves to nothing starts nothing", async () => {
    resolvedPick = null;
    send("vellum:companion:toggleWatch", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 2,
    });
    await Bun.sleep(0);
    expect(dispatched).toHaveLength(0);
  });

  test("refuses a pick that names nothing the contract knows", () => {
    expect(() => {
      send("vellum:companion:toggleWatch", { kind: "camera" });
    }).toThrow();
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
    expect(introOnAdvance("talk", "next")).toBe("menu");
  });

  // Past the last beat there is no next one, and `null` is what main reads as
  // the run being over and worth recording.
  test("falls off the end of the last beat", () => {
    expect(introOnAdvance("menu", "next")).toBe(null);
  });

  test("dismiss ends the run from any beat", () => {
    expect(introOnAdvance("meet", "dismiss")).toBe(null);
    expect(introOnAdvance("talk", "dismiss")).toBe(null);
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
      small: { maxReach: 322, canvasWidth: 692, canvasHeight: 267 },
      medium: { maxReach: 445, canvasWidth: 962, canvasHeight: 374 },
      large: { maxReach: 662, canvasWidth: 1420, canvasHeight: 547 },
      huge: { maxReach: 879, canvasWidth: 1878, canvasHeight: 720 },
      ridiculous: { maxReach: 1140, canvasWidth: 2520, canvasHeight: 1035 },
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
        companionBoxFor("avatar", "large"),
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
        companionBoxFor("options", "large"),
      );
    }
  });

  /**
   * The two sides of the avatar at each step, as the numbers they come to.
   *
   * Not one scale times the authored pair: a name is a creature and a pill a
   * notch apart, so the two sides move at different rates and each step is its
   * own canvas. The authored pair is stated first, since each of these is that
   * one layout scaled.
   */
  test("states both sides of the avatar at every named step", () => {
    // The pill's bottom sits 14 under the avatar's centre, so its top stands
    // 30 over it where the creature's box reaches only 22, and the card rises
    // its whole height off that same line. Both sides then take the pad.
    expect(
      companionNearEdgeFor(
        COMPANION_BASE_AVATAR_BOX,
        COMPANION_BASE_AVATAR_BOX,
      ),
    ).toBe(54);
    expect(
      companionCardSideFor(
        COMPANION_BASE_AVATAR_BOX,
        COMPANION_BASE_AVATAR_BOX,
      ),
    ).toBe(300);
    const sides: Record<
      CompanionSize,
      { riseAbove: number; dropBelow: number }
    > = {
      small: { riseAbove: 221, dropBelow: 46 },
      medium: { riseAbove: 305, dropBelow: 69 },
      large: { riseAbove: 455, dropBelow: 92 },
      huge: { riseAbove: 605, dropBelow: 115 },
      ridiculous: { riseAbove: 805, dropBelow: 230 },
    };
    for (const size of COMPANION_SIZES) {
      const { riseAbove, dropBelow } = geometryFor(size, size);
      expect({ riseAbove, dropBelow }).toEqual(sides[size]);
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
   * The two offsets are whole points too, and the width is even: the avatar
   * sits on the canvas's centre line and on the line between the offsets, so a
   * fraction anywhere here stands the creature on a half point that a resize
   * cannot land back on. The options axis is where this bites, since its
   * smaller steps are not whole multiples of the box the layout is authored at.
   */
  test("gives every size a whole-point canvas", () => {
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size, size);
      expect(Number.isInteger(geometry.canvasWidth)).toBe(true);
      expect(Number.isInteger(geometry.canvasHeight)).toBe(true);
      expect(Number.isInteger(geometry.riseAbove)).toBe(true);
      expect(Number.isInteger(geometry.dropBelow)).toBe(true);
      expect(Number.isInteger(geometry.maxReach)).toBe(true);
      expect(geometry.canvasWidth % 2).toBe(0);
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
   * below takes its small pill's gap rather than the chasm its own scale would
   * ask for, which would put its reach at 376. The two heights are the two
   * sides of the avatar: the near edge clears the creature's box and the pill's
   * top alike, and the far edge clears the card growing either way.
   */
  test("holds the pill, the card and the creature at each mix", () => {
    // An enormous creature's half box, the gap its small pill earns, and that
    // pill at its widest.
    expect(BIG_CREATURE).toEqual({
      avatarBox: 110,
      optionsBox: 32,
      maxReach: 355,
      canvasWidth: 830,
      riseAbove: 274,
      dropBelow: 115,
      canvasHeight: 389,
    });
    // A base half box, the base gap, and a pill twice as wide.
    expect(BIG_OPTIONS).toEqual({
      avatarBox: 44,
      optionsBox: 88,
      maxReach: 834,
      canvasWidth: 1764,
      riseAbove: 614,
      dropBelow: 122,
      canvasHeight: 736,
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
    const enormousOptions = geometryFor("small", "ridiculous");
    expect(
      growthFor(
        DISPLAY.width - enormousOptions.maxReach + 1,
        DISPLAY,
        enormousOptions,
      ),
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
    let opened = false;
    const items = companionContextMenuTemplate(current, {
      open: () => {
        opened = true;
      },
      setSize: () => {},
      hide: () => {
        hidden = true;
      },
    }) as MenuItem[];
    return { items, wasHidden: () => hidden, wasOpened: () => opened };
  };

  /**
   * The way back to Vellum leads, since a press on the creature is a call now
   * and this is where going back to the app lives.
   */
  test("opens with the way back to Vellum", () => {
    const { items, wasOpened } = build();
    expect(items.slice(0, 2).map((item) => item.label ?? item.type)).toEqual([
      "Open Vellum",
      "separator",
    ]);
    items[0]?.click?.();
    expect(wasOpened()).toBe(true);
  });

  test("closes with a separator and the way out, past the headings", () => {
    expect(
      build()
        .items.map((item) => item.label ?? item.type)
        .slice(4),
    ).toEqual(["separator", "Hide Companion"]);
  });

  /**
   * The headings are the shared builder's output rather than a second set of
   * items, so the surface's menu and the tray's cannot describe the same choice
   * differently. Compared as data, since the clicks are closures.
   */
  test("draws its two headings from the builder the tray reads", () => {
    const current = { avatar: "ridiculous", options: "medium" } as const;
    expect(JSON.stringify(build(current).items.slice(2, 4))).toBe(
      JSON.stringify(companionSizeSubmenus(current, () => {})),
    );
  });

  test("the last item takes the surface away", () => {
    const menu = build();
    menu.items[5]?.click?.();
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

describe("the offer of Vellum's dictation on the surface", () => {
  beforeEach(() => {
    dispatched.length = 0;
    windowsRaised = 0;
    mainWindowOpen = true;
    send("vellum:companion:setContext", context());
    pushes.length = 0;
  });

  test("carries the offer through to the surface", () => {
    send("vellum:companion:setContext", {
      ...context(),
      dictationOffer: { app: "Wispr Flow", text: "Send me the files." },
    });
    expect(state().dictationOffer).toEqual({
      app: "Wispr Flow",
      text: "Send me the files.",
    });
  });

  /**
   * The words and the way into the application they would go to went down
   * with that window, so an offer left standing is one whose answers do
   * nothing.
   */
  test("stops offering once the window that made the offer is gone", () => {
    send("vellum:companion:setContext", {
      ...context(),
      dictationOffer: { app: "Wispr Flow", text: "Send me the files." },
    });
    expect(state().dictationOffer).toBeDefined();

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(state().dictationOffer).toBeUndefined();
  });

  test("a context with no offer reports none", () => {
    send("vellum:companion:setContext", context());
    expect(state().dictationOffer).toBeUndefined();
  });

  /**
   * Every answer acts on the application in front, or on nothing, and the
   * user is standing in that application, so none of them raises the app.
   */
  test("forwards every answer without raising the app", () => {
    for (const answer of ["use", "quit", "dismiss"] as const) {
      send("vellum:companion:answerDictationOffer", answer);
    }
    expect(dispatched).toEqual([
      { kind: "answerDictationOffer", answer: "use" },
      { kind: "answerDictationOffer", answer: "quit" },
      { kind: "answerDictationOffer", answer: "dismiss" },
    ]);
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
   * The name is a record of whose surface this is and the surface is still
   * where it is read, the same bargain `clearCompanionWorking` makes.
   */
  test("leaves the name standing", () => {
    send("vellum:companion:setContext", context({ watching: true }));

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(state().assistantName).toBe("Ziggy");
  });

  test("says nothing when no session was running", () => {
    send("vellum:companion:setContext", context({ watching: false }));
    const before = pushes.length;

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(pushes.length).toBe(before);
  });

  /**
   * A held key's recording lives in the same window, and goes down with it
   * the same way. Left standing, the pill would go on listening to a
   * microphone that is no longer open, with the last words it heard in it.
   */
  test("gives up a dictation the same way", () => {
    send(
      "vellum:companion:setContext",
      context({ dictating: "listening", dictationText: "the quick brown" }),
    );
    expect(state().dictating).toBe("listening");

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(state().dictating).toBeUndefined();
    expect(state().dictationText).toBeUndefined();
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

// The identity main holds, which is what opens the surface after a sign-in.
// Imported after the mocks for the same reason the module under test is.
const { setName } = await import("@vellumai/electron-desktop/identity");

describe("the surface while the app is in front", () => {
  test("steps off the screen when the app comes forward", () => {
    fireAppEvent("did-become-active");

    expect(surface.visible).toBe(false);
  });

  test("comes back when the user goes to another app", () => {
    fireAppEvent("did-become-active");
    fireAppEvent("did-resign-active");

    expect(surface.visible).toBe(true);
  });

  test("stays while the active app's window is put away", () => {
    mainWindowVisible = false;

    fireAppEvent("did-become-active");

    expect(surface.visible).toBe(true);
  });

  test("stays while the active app's window is closed", () => {
    mainWindowOpen = false;

    fireAppEvent("did-become-active");

    expect(surface.visible).toBe(true);
  });

  test("steps off once the active app's window shows", () => {
    mainWindowVisible = false;
    fireAppEvent("did-become-active");

    mainWindowVisible = true;
    fireVisibilityChange();

    expect(surface.visible).toBe(false);
  });

  test("comes back when the window is put away from the tray", () => {
    fireAppEvent("did-become-active");

    mainWindowVisible = false;
    fireVisibilityChange();

    expect(surface.visible).toBe(true);
  });

  test("comes back when the window is closed", () => {
    fireAppEvent("did-become-active");

    mainWindowOpen = false;
    fireVisibilityChange();

    expect(surface.visible).toBe(true);
  });

  test("reads the app's window taking focus as the app being in front", () => {
    fireAppEvent("browser-window-focus", mainWindow);

    expect(surface.visible).toBe(false);
  });

  test("does not read a panel taking focus as the app being in front", () => {
    fireAppEvent("browser-window-focus", {});

    expect(surface.visible).toBe(true);
  });

  test("opens straight off the screen over an app already in front", () => {
    surface.close();
    fireAppEvent("did-become-active");

    setName("Aria");

    expect(companionOpen).toBe(true);
    expect(surface.visible).toBe(false);
    setName(null);
  });

  test("opens on the screen when the user is working elsewhere", () => {
    surface.close();

    setName("Aria");

    expect(companionOpen).toBe(true);
    expect(surface.visible).toBe(true);
    setName(null);
  });

  test("a surface put away by the tray is not brought back by the app", () => {
    surface.close();
    fireAppEvent("did-become-active");

    fireAppEvent("did-resign-active");

    expect(companionOpen).toBe(false);
  });
});

/**
 * Share, which takes the picker's pick the way Teach does and means the
 * opposite thing by a press with none: the stop, since the surface can see
 * a share is on. The frames themselves are the helper's; what this file
 * holds is that main reaches it with the target it was given.
 */
describe("Share on the companion surface", () => {
  beforeEach(() => {
    mainWindowOpen = true;
    dispatched.length = 0;
    framesAsked.length = 0;
    capturedFrame = { jpegBase64: "/9j/", width: 16, height: 9 };
  });

  test("a press with no pick is the stop", () => {
    send("vellum:companion:setScreenShare");
    expect(dispatched.at(-1)).toEqual({ kind: "setScreenShare" });
    expect(picksResolved).toHaveLength(0);
  });

  test("a pick is resolved and rides the command as the share's target", async () => {
    resolvedPick = { kind: "window", windowId: 4242 };
    send("vellum:companion:setScreenShare", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 2,
    });
    await Bun.sleep(0);
    expect(picksResolved.at(-1)).toEqual({
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 2,
    });
    expect(dispatched.at(-1)).toEqual({
      kind: "setScreenShare",
      target: { kind: "window", windowId: 4242 },
    });
  });

  /**
   * The two controls share one picker and one generation: a pick still
   * resolving for Share when Teach is pressed belonged to a choice the user
   * has left, and must not start a share beside the session.
   */
  test("a share pick superseded by a Teach press dispatches nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = resolvedPickAsync;
    resolvedPickAsync = async () => {
      await gate;
      return { kind: "window", windowId: 1 };
    };
    send("vellum:companion:setScreenShare", {
      kind: "tab",
      chromeWindowId: 3,
      tabIndex: 1,
    });
    resolvedPickAsync = slow;
    send("vellum:companion:toggleWatch");
    release();
    await Bun.sleep(0);
    expect(dispatched).toEqual([{ kind: "toggleWatch" }]);
  });

  test("takes a frame of the shared target from the helper", async () => {
    const capture = invocable.get("vellum:companion:captureScreen");
    expect(capture).toBeDefined();
    expect(await capture?.([{ kind: "display", displayId: 2 }])).toEqual({
      jpegBase64: "/9j/",
      width: 16,
      height: 9,
    });
    expect(framesAsked).toEqual([{ kind: "display", displayId: 2 }]);
    capturedFrame = null;
    expect(await capture?.([{ kind: "window", windowId: 7 }])).toBeNull();
  });

  test("carries the share and whether one may start to the surface", () => {
    send(
      "vellum:companion:setContext",
      context({
        screenShareEnabled: true,
        screenShare: { kind: "window", windowId: 7 },
      }),
    );
    expect(state().screenShare).toEqual({ kind: "window", windowId: 7 });
    expect(state().screenShareEnabled).toBe(true);
    send("vellum:companion:setContext", context());
    expect(state().screenShare).toBeUndefined();
    expect(state().screenShareEnabled).toBe(false);
  });

  /**
   * The frame says what is being shown, the way it says what is being read:
   * a share with no session reading the screen frames the shared display.
   */
  test("frames what is shared when nothing is reading the screen", () => {
    send(
      "vellum:companion:setContext",
      context({ screenShare: { kind: "display", displayId: 2 } }),
    );
    expect(glow?.bounds).toEqual({ x: 1440, y: 0, width: 1920, height: 1080 });
    send("vellum:companion:setContext", context());
    expect(glow).toBeNull();
  });

  test("the share ends with the window holding it", () => {
    send(
      "vellum:companion:setContext",
      context({
        screenShareEnabled: true,
        screenShare: { kind: "display", displayId: 2 },
      }),
    );
    mainWindowOpen = false;
    fireVisibilityChange();
    expect(state().screenShare).toBeUndefined();
    expect(state().screenShareEnabled).toBe(false);
    expect(glow).toBeNull();
  });
});
