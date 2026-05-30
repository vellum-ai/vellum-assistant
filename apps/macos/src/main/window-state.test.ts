import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SavedState = {
  x: number;
  y: number;
  width: number;
  height: number;
  isFullScreen: boolean;
};

let savedWindows: Record<string, SavedState> = {};
let workArea = { x: 0, y: 0, width: 1920, height: 1080 };

// Mock `electron-store` so `restoreBounds` reads from `savedWindows`
// without touching disk. The store wrapper in `window-state.ts` uses the
// default export, so the mock returns a class.
mock.module("electron-store", () => ({
  default: class {
    get(_key: string, _fallback: { windows: Record<string, SavedState> }) {
      return savedWindows;
    }
    set() {
      // no-op
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

const { restoreBounds } = await import("./window-state");

const DEFAULTS = { width: 800, height: 600 };

beforeEach(() => {
  savedWindows = {};
  workArea = { x: 0, y: 0, width: 1920, height: 1080 };
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
