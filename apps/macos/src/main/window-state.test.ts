import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SavedState = {
  x: number;
  y: number;
  width: number;
  height: number;
  isFullScreen: boolean;
};

let savedWindows: Record<string, SavedState> = {};
let savedOnboardingActive: boolean | undefined = undefined;
let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const storeSetMock = mock((_key: string, _value: unknown) => {});

// Mock `electron-store` so the wrappers read from the per-key test state
// without touching disk. Key-aware so `readOnboardingActive` can be
// exercised independently of the saved-windows map. The store wrapper in
// `window-state.ts` uses the default export, so the mock returns a class.
mock.module("electron-store", () => ({
  default: class {
    get(key: string, fallback?: unknown) {
      if (key === "onboardingActive") return savedOnboardingActive;
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
  },
}));

const { restoreBounds, track, readOnboardingActive, writeOnboardingActive } =
  await import("./window-state");

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
  };
}

beforeEach(() => {
  savedWindows = {};
  savedOnboardingActive = undefined;
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
      fullscreen: false,
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
  test("fresh install (no flag, no saved main window) → onboarding", () => {
    savedOnboardingActive = undefined;
    savedWindows = {};
    expect(readOnboardingActive()).toBe(true);
  });

  test("upgraded install (no flag, but saved main window) → not onboarding", () => {
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

  test("an explicit persisted flag wins over the derived default", () => {
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    savedOnboardingActive = true;
    expect(readOnboardingActive()).toBe(true);

    savedOnboardingActive = false;
    savedWindows = {};
    expect(readOnboardingActive()).toBe(false);
  });

  test("writeOnboardingActive skips persisting when the effective value is unchanged", () => {
    // Upgraded install: derived default is already `false`, so re-asserting
    // `false` must not write.
    savedWindows.main = {
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
      isFullScreen: false,
    };
    writeOnboardingActive(false);
    expect(storeSetMock).not.toHaveBeenCalled();

    writeOnboardingActive(true);
    expect(storeSetMock).toHaveBeenCalledWith("onboardingActive", true);
  });
});
