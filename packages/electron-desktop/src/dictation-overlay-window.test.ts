import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  BrowserWindow: class {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
}));

const { CURSOR_HOVER_POLL_MS, createCursorHoverForwarder } =
  await import("./dictation-overlay-window");

type Rect = { x: number; y: number; width: number; height: number };

const OVERLAY_BOUNDS: Rect = { x: 100, y: 50, width: 480, height: 160 };

const createHarness = () => {
  const state = {
    cursor: { x: 0, y: 0 },
    bounds: OVERLAY_BOUNDS as Rect | null,
    interactive: false,
    moves: [] as Array<{ x: number; y: number }>,
    leaves: 0,
    intervals: 0,
    intervalMs: null as number | null,
    cleared: 0,
  };
  let tick: (() => void) | null = null;

  const forwarder = createCursorHoverForwarder({
    getCursor: () => state.cursor,
    getOverlayBounds: () => state.bounds,
    isInteractive: () => state.interactive,
    sendMouseMove: (point) => {
      state.moves.push(point);
    },
    sendMouseLeave: () => {
      state.leaves += 1;
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

  return { forwarder, state, tick: () => tick?.() };
};

describe("createCursorHoverForwarder", () => {
  test("forwards window-relative moves while the cursor is inside the overlay", () => {
    const h = createHarness();
    h.forwarder.start();
    expect(h.state.intervalMs).toBe(CURSOR_HOVER_POLL_MS);

    h.state.cursor = { x: 120, y: 60 };
    h.tick();
    h.state.cursor = { x: 579, y: 209 };
    h.tick();

    expect(h.state.moves).toEqual([
      { x: 20, y: 10 },
      { x: 479, y: 159 },
    ]);
    expect(h.state.leaves).toBe(0);
  });

  test("sends a single leave when the cursor exits the overlay", () => {
    const h = createHarness();
    h.forwarder.start();

    h.state.cursor = { x: 120, y: 60 };
    h.tick();
    h.state.cursor = { x: 700, y: 60 };
    h.tick();
    h.tick();

    expect(h.state.moves).toHaveLength(1);
    expect(h.state.leaves).toBe(1);
  });

  test("does not re-deliver moves while the cursor is stationary", () => {
    const h = createHarness();
    h.forwarder.start();

    h.state.cursor = { x: 120, y: 60 };
    h.tick();
    h.tick();
    h.state.cursor = { x: 121, y: 60 };
    h.tick();

    expect(h.state.moves).toEqual([
      { x: 20, y: 10 },
      { x: 21, y: 10 },
    ]);
  });

  test("stays quiet while the cursor has never entered the overlay", () => {
    const h = createHarness();
    h.forwarder.start();

    h.state.cursor = { x: 0, y: 0 };
    h.tick();
    h.tick();

    expect(h.state.moves).toHaveLength(0);
    expect(h.state.leaves).toBe(0);
  });

  test("pauses while interactive, then leaves once the pointer moves away", () => {
    const h = createHarness();
    h.forwarder.start();

    h.state.cursor = { x: 120, y: 60 };
    h.tick();
    h.state.interactive = true;
    h.tick();
    expect(h.state.moves).toHaveLength(1);

    // The page drops interactivity after the pointer has already left.
    h.state.interactive = false;
    h.state.cursor = { x: 700, y: 60 };
    h.tick();
    expect(h.state.leaves).toBe(1);
  });

  test("stops itself once the overlay window is gone", () => {
    const h = createHarness();
    h.forwarder.start();

    h.state.bounds = null;
    h.tick();

    expect(h.state.cleared).toBe(1);
  });

  test("start is idempotent and stop clears the timer", () => {
    const h = createHarness();
    h.forwarder.start();
    h.forwarder.start();
    expect(h.state.intervals).toBe(1);

    h.forwarder.stop();
    expect(h.state.cleared).toBe(1);
    h.forwarder.start();
    expect(h.state.intervals).toBe(2);
  });
});
