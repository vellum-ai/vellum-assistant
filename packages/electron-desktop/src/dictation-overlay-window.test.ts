import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  BrowserWindow: class {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
}));

const { CURSOR_HOVER_POLL_MS, createCursorHoverPoller } =
  await import("./dictation-overlay-window");

type Rect = { x: number; y: number; width: number; height: number };

const OVERLAY_BOUNDS: Rect = { x: 100, y: 50, width: 480, height: 160 };
// The Stop control, window-relative: x 400..420, y 20..40 on screen
// 500..520 x 70..90.
const STOP_REGION: Rect = { x: 400, y: 20, width: 20, height: 20 };

const createHarness = () => {
  const state = {
    cursor: { x: 0, y: 0 },
    bounds: OVERLAY_BOUNDS as Rect | null,
    region: STOP_REGION as Rect | null,
    zoom: 1,
    interactive: false,
    toggles: [] as boolean[],
    intervals: 0,
    intervalMs: null as number | null,
    cleared: 0,
  };
  let tick: (() => void) | null = null;

  const poller = createCursorHoverPoller({
    getCursor: () => state.cursor,
    getOverlayBounds: () => state.bounds,
    getHitRegion: () => state.region,
    getZoomFactor: () => state.zoom,
    isInteractive: () => state.interactive,
    setInteractive: (interactive) => {
      state.interactive = interactive;
      state.toggles.push(interactive);
    },
    setInterval: (callback, ms) => {
      state.intervals += 1;
      state.intervalMs = ms;
      tick = callback;
      return state.intervals;
    },
    clearInterval: () => {
      state.cleared += 1;
      tick = null;
    },
  });

  return { poller, state, tick: () => tick?.() };
};

describe("createCursorHoverPoller", () => {
  test("makes the overlay interactive only while the cursor is over the Stop region", () => {
    const h = createHarness();
    h.poller.start();
    expect(h.state.intervalMs).toBe(CURSOR_HOVER_POLL_MS);

    h.state.cursor = { x: 110, y: 60 };
    h.tick();
    expect(h.state.toggles).toEqual([]);

    h.state.cursor = { x: 510, y: 80 };
    h.tick();
    expect(h.state.toggles).toEqual([true]);

    h.state.cursor = { x: 530, y: 80 };
    h.tick();
    expect(h.state.toggles).toEqual([true, false]);
  });

  test("does not re-toggle while the hover state is unchanged", () => {
    const h = createHarness();
    h.poller.start();

    h.state.cursor = { x: 510, y: 80 };
    h.tick();
    h.tick();
    h.tick();

    expect(h.state.toggles).toEqual([true]);
  });

  test("scales the CSS-pixel region by the page zoom factor", () => {
    const h = createHarness();
    h.state.zoom = 2;
    h.poller.start();

    // At zoom 2 the region's DIP footprint is 900..940 x 90..130; the
    // unzoomed position must no longer hit.
    h.state.cursor = { x: 510, y: 80 };
    h.tick();
    expect(h.state.toggles).toEqual([]);

    h.state.cursor = { x: 920, y: 110 };
    h.tick();
    expect(h.state.toggles).toEqual([true]);
  });

  test("stays click-through while no Stop region is reported", () => {
    const h = createHarness();
    h.state.region = null;
    h.poller.start();

    h.state.cursor = { x: 510, y: 80 };
    h.tick();

    expect(h.state.toggles).toEqual([]);
  });

  test("drops interactivity when the region is cleared under the cursor", () => {
    const h = createHarness();
    h.poller.start();

    h.state.cursor = { x: 510, y: 80 };
    h.tick();
    h.state.region = null;
    h.tick();

    expect(h.state.toggles).toEqual([true, false]);
  });

  test("respects interactivity the renderer set on its own", () => {
    const h = createHarness();
    h.poller.start();

    // Real mouse events reached the page and it asked for interactivity;
    // a cursor inside the region must not produce a redundant toggle.
    h.state.interactive = true;
    h.state.cursor = { x: 510, y: 80 };
    h.tick();

    expect(h.state.toggles).toEqual([]);
  });

  test("stops itself once the overlay window is gone", () => {
    const h = createHarness();
    h.poller.start();

    h.state.bounds = null;
    h.tick();

    expect(h.state.cleared).toBe(1);
  });

  test("start is idempotent and stop clears the timer", () => {
    const h = createHarness();
    h.poller.start();
    h.poller.start();
    expect(h.state.intervals).toBe(1);

    h.poller.stop();
    expect(h.state.cleared).toBe(1);
    h.poller.start();
    expect(h.state.intervals).toBe(2);
  });
});
