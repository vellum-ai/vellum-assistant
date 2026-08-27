import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SavedState = {
  x: number;
  y: number;
  width: number;
  height: number;
  isFullScreen: boolean;
  isMaximized?: boolean;
};

let savedWindows: Record<string, SavedState> = {};
let savedOnboardingActive: boolean | undefined = undefined;
let savedCompanionHidden: boolean | undefined = undefined;
let savedCompanionIntroSeen: boolean | undefined = undefined;
let savedCompanionSize: unknown = undefined;
let savedCompanionAvatarSize: unknown = undefined;
let savedCompanionOptionsSize: unknown = undefined;
let savedTitleBarOverlay: unknown = undefined;
let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const storeSetMock = mock((_key: string, _value: unknown) => {});

// Mock `electron-store` so the wrappers read from the per-key test state
// without touching disk. Key-aware so `readOnboardingActive` can be
// exercised independently of the saved-windows map. The store wrapper in
// `window-state.ts` uses the default export, so the mock returns a class.
mock.module("electron-store", () => ({
  default: class {
    get(key: string, fallback?: unknown) {
      // Mirror electron-store: return the stored value, or the fallback
      // when the key is absent.
      if (key === "onboardingActive") return savedOnboardingActive ?? fallback;
      if (key === "companionHidden") return savedCompanionHidden ?? fallback;
      if (key === "companionIntroSeen")
        return savedCompanionIntroSeen ?? fallback;
      if (key === "companionSize") {
        return savedCompanionSize ?? fallback;
      }
      if (key === "companionAvatarSize") {
        return savedCompanionAvatarSize ?? fallback;
      }
      if (key === "companionOptionsSize") {
        return savedCompanionOptionsSize ?? fallback;
      }
      if (key === "titleBarOverlay") return savedTitleBarOverlay ?? fallback;
      if (key === "windows") return savedWindows;
      return fallback;
    }
    set(key: string, value: unknown) {
      storeSetMock(key, value);
    }
  },
}));

// Override the `screen` surface from `test-setup.ts` so each test can
// shape the work-area to its scenario.
mock.module("electron", () => ({
  BrowserWindow: class {},
  screen: {
    getDisplayMatching: () => ({ workArea }),
    getPrimaryDisplay: () => ({ workArea }),
  },
}));

const {
  restoreBounds,
  track,
  readCompanionHidden,
  readCompanionIntroSeen,
  readCompanionSize,
  readOnboardingActive,
  readTitleBarOverlayTheme,
  writeCompanionHidden,
  writeCompanionIntroSeen,
  writeCompanionSize,
  writeOnboardingActive,
  writeTitleBarOverlayTheme,
} = await import("./window-state");

const DEFAULTS = { width: 800, height: 600 };

// Minimal `BrowserWindow` stub for `track`: captures registered event
// handlers so a test can fire `close` (the synchronous persist path) and
// assert whether the store was written.
function makeTrackableWindow() {
  const handlers = new Map<string, () => void>();
  return {
    on(event: string, cb: () => void) {
      handlers.set(event, cb);
    },
    emit(event: string) {
      handlers.get(event)?.();
    },
    isDestroyed: () => false,
    getNormalBounds: () => ({ x: 1, y: 2, width: 440, height: 630 }),
    isFullScreen: () => false,
    isMaximized: () => false,
  };
}

beforeEach(() => {
  savedWindows = {};
  savedOnboardingActive = undefined;
  savedCompanionHidden = undefined;
  savedCompanionIntroSeen = undefined;
  savedCompanionSize = undefined;
  savedCompanionAvatarSize = undefined;
  savedCompanionOptionsSize = undefined;
  savedTitleBarOverlay = undefined;
  workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  storeSetMock.mockClear();
});

afterEach(() => {
  savedWindows = {};
});

describe("restoreBounds", () => {
  test("returns the supplied defaults when no state has been persisted", () => {
    expect(restoreBounds("main", DEFAULTS)).toEqual(DEFAULTS);
  });

  test("returns the saved rectangle when it fits inside the work area", () => {
    savedWindows.main = {
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    expect(restoreBounds("main", DEFAULTS)).toEqual({
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
    });
  });

  test("clamps width and height to the work area when the display shrunk", () => {
    workArea = { x: 0, y: 0, width: 800, height: 600 };
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 1600,
      height: 1200,
      isFullScreen: false,
    };
    const result = restoreBounds("main", DEFAULTS);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  test("clamps saved bounds after a DPI work-area change", () => {
    workArea = { x: 120, y: 80, width: 1280, height: 720 };
    savedWindows.main = {
      x: 1800,
      y: 900,
      width: 1600,
      height: 900,
      isFullScreen: false,
    };
    expect(restoreBounds("main", DEFAULTS)).toEqual({
      x: 120,
      y: 80,
      width: 1280,
      height: 720,
    });
  });

  test("falls back when persisted state is corrupt", () => {
    savedWindows.main = {
      x: Number.NaN,
      y: 0,
      width: -1,
      height: 600,
      isFullScreen: false,
    };
    expect(restoreBounds("main", DEFAULTS)).toEqual(DEFAULTS);
  });

  test("clamps x and y into the work area when the window was off-screen", () => {
    workArea = { x: 0, y: 0, width: 1024, height: 768 };
    savedWindows.main = {
      x: 5000,
      y: 5000,
      width: 400,
      height: 300,
      isFullScreen: false,
    };
    const result = restoreBounds("main", DEFAULTS);
    expect(result.x).toBe(1024 - 400);
    expect(result.y).toBe(768 - 300);
  });

  test("clamps negative origins into the work area's top-left", () => {
    savedWindows.main = {
      x: -500,
      y: -500,
      width: 400,
      height: 300,
      isFullScreen: false,
    };
    const result = restoreBounds("main", DEFAULTS);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  test("respects non-zero work-area origins (external monitor offset)", () => {
    workArea = { x: 1920, y: 0, width: 1920, height: 1080 };
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      isFullScreen: false,
    };
    const result = restoreBounds("main", DEFAULTS);
    expect(result.x).toBe(1920);
    expect(result.y).toBe(0);
  });

  test("forwards the fullscreen flag when saved", () => {
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      isFullScreen: true,
    };
    expect(restoreBounds("main", DEFAULTS).fullscreen).toBe(true);
  });

  test("omits fullscreen for a windowed session so BrowserWindow stays fullscreenable", () => {
    savedWindows.main = {
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    expect(restoreBounds("main", DEFAULTS)).not.toHaveProperty("fullscreen");
  });

  test("forwards a saved maximized flag", () => {
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      isFullScreen: false,
      isMaximized: true,
    };
    expect(restoreBounds("main", DEFAULTS).maximized).toBe(true);
  });

  test("returns the primary display's work area for the maximized default", () => {
    workArea = { x: 0, y: 25, width: 1512, height: 944 };
    expect(restoreBounds("main", "maximized")).toEqual({
      x: 0,
      y: 25,
      width: 1512,
      height: 944,
    });
  });

  test("a saved state overrides the maximized default", () => {
    savedWindows.main = {
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    expect(restoreBounds("main", "maximized")).toEqual({
      x: 100,
      y: 200,
      width: 1000,
      height: 700,
    });
  });

  test("namespaces by key so windows don't clobber each other", () => {
    savedWindows.main = {
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      isFullScreen: false,
    };
    savedWindows["thread.abc"] = {
      x: 500,
      y: 500,
      width: 400,
      height: 300,
      isFullScreen: false,
    };
    expect(restoreBounds("main", DEFAULTS).x).toBe(10);
    expect(restoreBounds("thread.abc", DEFAULTS).x).toBe(500);
  });
});

describe("track persistence gating", () => {
  test("persists on close by default", () => {
    const win = makeTrackableWindow();
    track("main", win as never);
    win.emit("close");
    expect(storeSetMock).toHaveBeenCalledTimes(1);
  });

  test("skips persistence while shouldPersist returns false", () => {
    const win = makeTrackableWindow();
    track("main", win as never, () => false);
    win.emit("close");
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  test("re-evaluates shouldPersist at save time, not bind time", () => {
    // Models the onboarding gate: don't persist the small onboarding
    // default, but capture the main bounds once the mode flips.
    let onboarding = true;
    const win = makeTrackableWindow();
    track("main", win as never, () => !onboarding);

    win.emit("close");
    expect(storeSetMock).not.toHaveBeenCalled();

    onboarding = false;
    win.emit("close");
    expect(storeSetMock).toHaveBeenCalledTimes(1);
  });
});

describe("readOnboardingActive default", () => {
  test("absent flag defaults to false: open large, not onboarding", () => {
    // Erring large is recoverable (onboarding self-shrinks via the hook);
    // erring small would strand the out-of-RootLayout /account/* screens.
    savedOnboardingActive = undefined;
    savedWindows = {};
    expect(readOnboardingActive()).toBe(false);
  });

  test("absent flag stays false regardless of saved window state", () => {
    savedOnboardingActive = undefined;
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    expect(readOnboardingActive()).toBe(false);
  });

  test("an explicit persisted flag wins over the default", () => {
    savedOnboardingActive = true;
    expect(readOnboardingActive()).toBe(true);

    savedOnboardingActive = false;
    expect(readOnboardingActive()).toBe(false);
  });

  test("writeOnboardingActive skips persisting when the effective value is unchanged", () => {
    // Absent flag → effective value is already `false`, so re-asserting
    // `false` must not write; flipping to `true` does.
    savedOnboardingActive = undefined;
    writeOnboardingActive(false);
    expect(storeSetMock).not.toHaveBeenCalled();

    writeOnboardingActive(true);
    expect(storeSetMock).toHaveBeenCalledWith("onboardingActive", true);
  });
});

describe("companion surface visibility flag", () => {
  test("absent flag defaults to shown", () => {
    expect(readCompanionHidden()).toBe(false);
  });

  test("an explicit persisted flag wins over the default", () => {
    savedCompanionHidden = true;
    expect(readCompanionHidden()).toBe(true);

    savedCompanionHidden = false;
    expect(readCompanionHidden()).toBe(false);
  });

  test("writeCompanionHidden skips persisting when the effective value is unchanged", () => {
    writeCompanionHidden(false);
    expect(storeSetMock).not.toHaveBeenCalled();

    writeCompanionHidden(true);
    expect(storeSetMock).toHaveBeenCalledWith("companionHidden", true);
  });
});

/**
 * The two sizes the companion surface is drawn at, which are one choice each
 * and share a set of steps.
 *
 * The file is JSON a user can edit and another build can have written, and the
 * values index a table of geometry, so what is worth stating is that only a
 * step this build knows ever reaches the window, that an install carrying only
 * the single size a one-axis build writes is not resized under its user, and
 * that a downgrade finds that shared key holding whatever both axes agree on.
 */
describe("companion surface sizes", () => {
  test("absent keys default to the shipped size on both axes", () => {
    expect(readCompanionSize("avatar")).toBe("medium");
    expect(readCompanionSize("options")).toBe("medium");
  });

  test("each axis reads its own key", () => {
    savedCompanionAvatarSize = "ridiculous";
    savedCompanionOptionsSize = "small";
    expect(readCompanionSize("avatar")).toBe("ridiculous");
    expect(readCompanionSize("options")).toBe("small");
  });

  /**
   * Nobody is resized by the second axis arriving. Someone who picked `huge`
   * from a menu that offered one size meant the thing they were looking at, so
   * they get `huge` on both rather than the default on either.
   */
  test("falls back to the one size a single-axis build writes", () => {
    savedCompanionSize = "huge";
    expect(readCompanionSize("avatar")).toBe("huge");
    expect(readCompanionSize("options")).toBe("huge");
  });

  test("an axis's own key wins over that fallback", () => {
    savedCompanionSize = "huge";
    savedCompanionOptionsSize = "small";
    expect(readCompanionSize("avatar")).toBe("huge");
    expect(readCompanionSize("options")).toBe("small");
  });

  test("a value this build does not know never reaches the window", () => {
    savedCompanionAvatarSize = "gigantic";
    savedCompanionSize = "enormous";
    expect(readCompanionSize("avatar")).toBe("medium");
  });

  test("an unknown axis key still finds the shared fallback", () => {
    savedCompanionAvatarSize = "gigantic";
    savedCompanionSize = "large";
    expect(readCompanionSize("avatar")).toBe("large");
  });

  test("writing one axis leaves the other alone", () => {
    writeCompanionSize("avatar", "ridiculous");
    expect(storeSetMock).toHaveBeenCalledWith(
      "companionAvatarSize",
      "ridiculous",
    );
    expect(storeSetMock).not.toHaveBeenCalledWith(
      "companionOptionsSize",
      "ridiculous",
    );
  });

  test("writing skips persisting when the axis's own key already says so", () => {
    savedCompanionOptionsSize = "large";
    writeCompanionSize("options", "large");
    expect(storeSetMock).not.toHaveBeenCalled();

    writeCompanionSize("options", "small");
    expect(storeSetMock).toHaveBeenCalledWith("companionOptionsSize", "small");
  });

  /**
   * The axis's own key, not the effective value that falls back to the shared
   * one. Someone carrying `huge` from a one-axis build who picks Huge on an
   * axis is asking for it to be that axis's own answer, and skipping the write
   * because the fallback already agreed would leave them on the fallback
   * forever.
   */
  test("an explicit pick matching the shared fallback still lands on its axis", () => {
    savedCompanionSize = "huge";
    writeCompanionSize("avatar", "huge");
    expect(storeSetMock).toHaveBeenCalledWith("companionAvatarSize", "huge");
  });

  /**
   * Both axes on one size is the whole of what a build with one size axis can
   * say, so it is said: someone who put the pair at `small` and then opened an
   * older build should find it small rather than a stale value or the default.
   */
  test("axes landing on the same size update the key a single-axis build reads", () => {
    savedCompanionAvatarSize = "small";
    writeCompanionSize("options", "small");
    expect(storeSetMock).toHaveBeenCalledWith("companionOptionsSize", "small");
    expect(storeSetMock).toHaveBeenCalledWith("companionSize", "small");
  });

  /**
   * Two different sizes are not representable there, and the shared key is not
   * asked to pick one: handing that build one axis's answer for both would turn
   * a user sizing the pill alone into one whose creature changed too.
   */
  test("axes that disagree leave that key alone", () => {
    savedCompanionSize = "small";
    savedCompanionAvatarSize = "ridiculous";
    writeCompanionSize("options", "huge");
    expect(storeSetMock).toHaveBeenCalledWith("companionOptionsSize", "huge");
    expect(
      storeSetMock.mock.calls.some(([key]) => key === "companionSize"),
    ).toBe(false);
  });

  /**
   * Agreement reached through the fallback counts, and there is nothing to
   * write: the key already holds the size both axes answer with.
   */
  test("a pick that agrees with the shared fallback does not rewrite it", () => {
    savedCompanionSize = "huge";
    writeCompanionSize("avatar", "huge");
    expect(storeSetMock).toHaveBeenCalledWith("companionAvatarSize", "huge");
    expect(
      storeSetMock.mock.calls.some(([key]) => key === "companionSize"),
    ).toBe(false);
  });

  /**
   * The key keeps the last size the two agreed on rather than being cleared or
   * dragged after the axis that moved. A build with one size axis then still
   * opens at a size its user chose.
   */
  test("a later disagreement leaves the key where the axes last agreed", () => {
    savedCompanionSize = "small";
    savedCompanionAvatarSize = "small";
    savedCompanionOptionsSize = "small";
    writeCompanionSize("avatar", "huge");
    expect(storeSetMock).toHaveBeenCalledWith("companionAvatarSize", "huge");
    expect(
      storeSetMock.mock.calls.some(([key]) => key === "companionSize"),
    ).toBe(false);
  });
});

describe("companion introduction seen flag", () => {
  /**
   * Absent means the run is still owed. That is the right way round: the
   * surface appears on the desktop without the user having opened it, and the
   * people most owed an explanation are the ones who have not had one.
   */
  test("absent flag defaults to not yet seen", () => {
    expect(readCompanionIntroSeen()).toBe(false);
  });

  test("an explicit persisted flag wins over the default", () => {
    savedCompanionIntroSeen = true;
    expect(readCompanionIntroSeen()).toBe(true);
  });

  test("writing records that the run has happened", () => {
    writeCompanionIntroSeen();
    expect(storeSetMock).toHaveBeenCalledWith("companionIntroSeen", true);
  });

  /**
   * One way only. Every path out of a run writes this, and more than one can
   * fire for the same run (the last beat, then the tray hiding the surface), so
   * re-asserting it must not churn the store file.
   */
  test("writing again once seen is a no-op", () => {
    savedCompanionIntroSeen = true;
    writeCompanionIntroSeen();
    expect(storeSetMock).not.toHaveBeenCalled();
  });
});

describe("windows title-bar overlay theme", () => {
  const DARK_OVERLAY = {
    color: "#17191C",
    symbolColor: "#F6F5F4",
    colorScheme: "dark",
  } as const;
  const VELVET_OVERLAY = {
    color: "#121214",
    symbolColor: "#F6F5F4",
    colorScheme: "dark",
  } as const;

  test("an absent theme leaves the overlay on its system colors", () => {
    // GIVEN nothing has been persisted

    // WHEN the theme is read
    const theme = readTitleBarOverlayTheme();

    // THEN there is nothing to override the system caption colors with
    expect(theme).toBeNull();
  });

  test("a persisted theme is returned for the next window's construction", () => {
    // GIVEN a renderer published the dark theme on a past launch
    savedTitleBarOverlay = DARK_OVERLAY;

    // WHEN the theme is read
    const theme = readTitleBarOverlayTheme();

    // THEN it comes back as stored, scheme included
    expect(theme).toEqual(DARK_OVERLAY);
  });

  test("a value that is not a pair of CSS colors is discarded", () => {
    // GIVEN a hand-edited store file holding something unparseable
    savedTitleBarOverlay = {
      color: "not a color",
      symbolColor: 42,
      colorScheme: "dark",
    };

    // WHEN the theme is read
    const theme = readTitleBarOverlayTheme();

    // THEN the overlay falls back to the system colors rather than carrying a
    // string Chromium's color parser would silently ignore
    expect(theme).toBeNull();
  });

  test("a theme written by a build that predates the scheme is discarded", () => {
    // GIVEN colors an older build persisted without the scheme they came from
    savedTitleBarOverlay = { color: "#17191C", symbolColor: "#F6F5F4" };

    // WHEN the theme is read
    const theme = readTitleBarOverlayTheme();

    // THEN the launch opens on the system colors rather than on a dark overlay
    // whose caption buttons would not wash on hover
    expect(theme).toBeNull();
  });

  test("writeTitleBarOverlayTheme skips persisting an unchanged theme", () => {
    // GIVEN the dark theme is already persisted
    savedTitleBarOverlay = DARK_OVERLAY;

    // WHEN the same theme is re-asserted, then a different one is
    writeTitleBarOverlayTheme(DARK_OVERLAY);
    expect(storeSetMock).not.toHaveBeenCalled();
    writeTitleBarOverlayTheme(VELVET_OVERLAY);

    // THEN only the change reaches the store
    expect(storeSetMock).toHaveBeenCalledTimes(1);
    expect(storeSetMock).toHaveBeenCalledWith(
      "titleBarOverlay",
      VELVET_OVERLAY,
    );
  });
});
