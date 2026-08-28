/**
 * Tests for the web frame sampler.
 *
 * The gate's own tests prove the decision. These prove the plumbing around it,
 * which is where a sampler goes wrong: a loop that keeps running after it was
 * stopped, a restart that leaves the old video still driving callbacks, a grid
 * copied per frame, a downscale chain wired in the wrong order.
 *
 * Both the canvas and the video are faked, because neither is real in a DOM
 * without a compositor: `getContext("2d")` returns null and no element ever
 * presents a frame. Stubbing them is also what makes a tick deterministic, so
 * an exact grid can be asserted rather than a plausible one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FRAME_GRID_CELLS,
  FRAME_GRID_SIZE,
  type FrameGate,
  type FrameGateDecision,
  type FrameGrid,
} from "./frame-gate";
import { createFrameSampler, lumaGridFromRgba } from "./frame-sampler";

/** The `readyState` at which a video holds a frame that can be drawn. */
const HAVE_CURRENT_DATA = 2;

/** Side length of the sampler's intermediate canvas. */
const INTERMEDIATE_SIZE = FRAME_GRID_SIZE * 4;

const STUB_DECISION: FrameGateDecision = {
  keep: true,
  reason: "first",
  motion: null,
  novelty: null,
  detail: 42,
};

interface RecordedOffer {
  readonly grid: FrameGrid;
  /** A snapshot, because the sampler hands the same buffer over every time. */
  readonly cells: readonly number[];
  readonly nowMs: number;
}

function createRecordingGate(): { gate: FrameGate; offers: RecordedOffer[] } {
  const offers: RecordedOffer[] = [];
  const gate: FrameGate = {
    offer(grid, nowMs) {
      offers.push({ grid, cells: Array.from(grid), nowMs });
      return STUB_DECISION;
    },
    reset() {},
  };
  return { gate, offers };
}

interface FakeVideoState {
  readyState: number;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

interface FakeVideo {
  /** What the sampler is started on. */
  readonly element: HTMLVideoElement;
  /** Mutable playback state, so a test can stall or pause the stream. */
  readonly state: FakeVideoState;
  pendingCount(): number;
  /**
   * Advance `currentTime` by one frame interval, as presenting a new picture
   * does. The animation-frame path reads that value to tell a fresh frame from
   * the one it already sampled.
   */
  presentFrame(): void;
  /** Run the callback the sampler is waiting on. False when it is not waiting. */
  fireFrame(): boolean;
}

/** Playback seconds a single presented frame covers, at 30 fps. */
const FRAME_INTERVAL_SECONDS = 1 / 30;

function createFakeVideo({ drivesLoop = true } = {}): FakeVideo {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;

  const state: FakeVideoState = {
    readyState: HAVE_CURRENT_DATA,
    paused: false,
    ended: false,
    currentTime: 0,
  };
  if (drivesLoop) {
    state.requestVideoFrameCallback = (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    };
    state.cancelVideoFrameCallback = (handle) => {
      pending.delete(handle);
    };
  }

  return {
    element: state as unknown as HTMLVideoElement,
    state,
    pendingCount: () => pending.size,
    presentFrame() {
      state.currentTime += FRAME_INTERVAL_SECONDS;
    },
    fireFrame() {
      const next = pending.entries().next();
      if (next.done) {
        return false;
      }
      const [handle, callback] = next.value;
      pending.delete(handle);
      // A video-frame callback fires once per presented frame, so the two go
      // together on this path.
      state.currentTime += FRAME_INTERVAL_SECONDS;
      callback();
      return true;
    },
  };
}

interface FakeContext {
  readonly canvas: HTMLCanvasElement;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  /** Argument lists of every `drawImage` call, in order. */
  readonly drawn: unknown[][];
  drawImage(...args: unknown[]): void;
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray };
}

interface CanvasStub {
  readonly contexts: FakeContext[];
  readonly settings: (CanvasRenderingContext2DSettings | undefined)[];
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
const realRequestAnimationFrame = globalThis.requestAnimationFrame;
const realCancelAnimationFrame = globalThis.cancelAnimationFrame;

function stubCanvasContexts(readback: () => Uint8ClampedArray): CanvasStub {
  const stub: CanvasStub = { contexts: [], settings: [] };
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    _contextId: string,
    contextSettings?: CanvasRenderingContext2DSettings,
  ) {
    stub.settings.push(contextSettings);
    const context: FakeContext = {
      canvas: this,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawn: [],
      drawImage(...args: unknown[]) {
        context.drawn.push(args);
      },
      getImageData: () => ({ data: readback() }),
    };
    stub.contexts.push(context);
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return stub;
}

interface AnimationFrameStub {
  pendingCount(): number;
  fireFrame(): boolean;
}

function stubAnimationFrame(): AnimationFrameStub {
  const pending = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    pending.set(handle, callback);
    return handle;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    pending.delete(handle);
  }) as typeof cancelAnimationFrame;
  return {
    pendingCount: () => pending.size,
    fireFrame() {
      const next = pending.entries().next();
      if (next.done) {
        return false;
      }
      const [handle, callback] = next.value;
      pending.delete(handle);
      callback(0);
      return true;
    },
  };
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** An RGBA readback of opaque grays, so each cell's luma equals its gray. */
function grayReadback(valueFor: (cell: number) => number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(FRAME_GRID_CELLS * 4);
  for (let cell = 0; cell < FRAME_GRID_CELLS; cell++) {
    const value = valueFor(cell);
    rgba[cell * 4] = value;
    rgba[cell * 4 + 1] = value;
    rgba[cell * 4 + 2] = value;
    rgba[cell * 4 + 3] = 255;
  }
  return rgba;
}

let readback: Uint8ClampedArray;
let canvasStub: CanvasStub;

beforeEach(() => {
  readback = grayReadback((cell) => cell);
  canvasStub = stubCanvasContexts(() => readback);
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  globalThis.requestAnimationFrame = realRequestAnimationFrame;
  globalThis.cancelAnimationFrame = realCancelAnimationFrame;
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("lumaGridFromRgba", () => {
  test("weights the channels as Rec. 601", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 10, 200, 30, 255]);
    const out = new Uint8Array(2);
    lumaGridFromRgba(rgba, out);
    // 0.299 * 255 and 0.299 * 10 + 0.587 * 200 + 0.114 * 30, rounded. The iOS
    // sampler computes the same two numbers from a BGRA buffer, which is what
    // lets one set of thresholds serve both.
    expect(Array.from(out)).toEqual([76, 124]);
  });

  test("carries a gray through unchanged, because the weights sum to one", () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);
    const out = new Uint8Array(3);
    lumaGridFromRgba(rgba, out);
    expect(Array.from(out)).toEqual([0, 128, 255]);
  });

  test("ignores alpha", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 255]);
    const out = new Uint8Array(2);
    lumaGridFromRgba(rgba, out);
    expect(out[0]).toBe(out[1]!);
  });

  test("fills a whole grid row major", () => {
    const out = new Uint8Array(FRAME_GRID_CELLS);
    lumaGridFromRgba(
      grayReadback((cell) => cell),
      out,
    );
    // Every cell distinct and ascending, so a transposed or strided read shows
    // up as a wrong value rather than passing by symmetry.
    for (let cell = 0; cell < FRAME_GRID_CELLS; cell++) {
      expect(out[cell]).toBe(cell);
    }
  });
});

describe("frame sampler extraction", () => {
  test("downscales through an intermediate canvas before reading back", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.fireFrame();
    sampler.stop();

    const [intermediate, grid] = canvasStub.contexts;
    expect(intermediate!.canvas.width).toBe(INTERMEDIATE_SIZE);
    expect(intermediate!.canvas.height).toBe(INTERMEDIATE_SIZE);
    expect(grid!.canvas.width).toBe(FRAME_GRID_SIZE);
    expect(grid!.canvas.height).toBe(FRAME_GRID_SIZE);

    // The video goes to the intermediate canvas, and the intermediate canvas
    // goes to the grid. Reading the video straight into 16x16 is the mistake
    // this asserts against: at that ratio the scaler point samples.
    expect(intermediate!.drawn).toEqual([
      [video.element, 0, 0, INTERMEDIATE_SIZE, INTERMEDIATE_SIZE],
    ]);
    expect(grid!.drawn).toEqual([
      [intermediate!.canvas, 0, 0, FRAME_GRID_SIZE, FRAME_GRID_SIZE],
    ]);
    expect(offers).toHaveLength(1);
  });

  test("asks for smoothing on both steps and a readable grid surface", () => {
    const { gate } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.fireFrame();
    sampler.stop();

    for (const context of canvasStub.contexts) {
      expect(context.imageSmoothingEnabled).toBe(true);
      expect(context.imageSmoothingQuality).toBe("high");
    }
    // Only the grid canvas is read back, and only it pays for the hint.
    expect(canvasStub.settings).toEqual([
      undefined,
      { willReadFrequently: true },
    ]);
  });

  test("turns one tick into a grid and a decision", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const decisions: { decision: FrameGateDecision; nowMs: number }[] = [];
    const sampler = createFrameSampler({
      gate,
      onDecision: (decision, nowMs) => {
        decisions.push({ decision, nowMs });
      },
    });

    sampler.start(video.element);
    video.fireFrame();
    sampler.stop();

    expect(offers).toHaveLength(1);
    expect(offers[0]!.cells).toEqual(
      Array.from({ length: FRAME_GRID_CELLS }, (_unused, cell) => cell),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe(STUB_DECISION);
    // The gate reads no clock of its own, so the sampler owes it one.
    expect(decisions[0]!.nowMs).toBe(offers[0]!.nowMs);
    expect(decisions[0]!.nowMs).toBeGreaterThan(0);
  });

  test("hands the gate one reused grid rather than a buffer per frame", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.fireFrame();
    readback = grayReadback((cell) => 255 - cell);
    video.fireFrame();
    sampler.stop();

    // Reuse is safe because the gate reads a grid synchronously and never
    // retains it, and it is what keeps a sampled frame allocation free.
    expect(offers).toHaveLength(2);
    expect(offers[1]!.grid).toBe(offers[0]!.grid);
    expect(offers[1]!.cells).not.toEqual(offers[0]!.cells);
  });

  test("keeps scheduling when no 2D context is available", () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.fireFrame();
    video.fireFrame();
    expect(offers).toHaveLength(0);
    expect(video.pendingCount()).toBe(1);
    sampler.stop();
  });
});

describe("frame sampler loop control", () => {
  test("samples every callback at the default stride", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    for (let frame = 0; frame < 4; frame++) {
      expect(video.fireFrame()).toBe(true);
    }
    sampler.stop();

    expect(offers).toHaveLength(4);
  });

  test("samples one callback in every stride, and reschedules on the rest", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({
      gate,
      onDecision: () => {},
      frameStride: 3,
    });

    sampler.start(video.element);
    for (let frame = 0; frame < 7; frame++) {
      // A skipped tick that failed to reschedule would end the loop here.
      expect(video.fireFrame()).toBe(true);
    }
    sampler.stop();

    expect(offers).toHaveLength(3);
  });

  test("clamps a stride below one instead of dividing by it", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({
      gate,
      onDecision: () => {},
      frameStride: 0,
    });

    sampler.start(video.element);
    video.fireFrame();
    video.fireFrame();
    sampler.stop();

    expect(offers).toHaveLength(2);
  });

  test("cancels the pending callback on stop", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.fireFrame();
    expect(video.pendingCount()).toBe(1);

    sampler.stop();
    expect(video.pendingCount()).toBe(0);
    expect(video.fireFrame()).toBe(false);
    expect(offers).toHaveLength(1);
  });

  test("stops idempotently", () => {
    const { gate } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.stop();
    sampler.start(video.element);
    sampler.stop();
    sampler.stop();
    expect(video.pendingCount()).toBe(0);
  });

  test("retargets a restart onto the new video", () => {
    const { gate, offers } = createRecordingGate();
    const first = createFakeVideo();
    const second = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(first.element);
    first.fireFrame();

    sampler.start(second.element);
    // Two loops running against one gate would interleave frames from two
    // streams, which is exactly what the gate cannot make sense of.
    expect(first.pendingCount()).toBe(0);
    expect(second.pendingCount()).toBe(1);

    second.fireFrame();
    sampler.stop();

    expect(offers).toHaveLength(2);
    expect(canvasStub.contexts[0]!.drawn.at(-1)).toEqual([
      second.element,
      0,
      0,
      INTERMEDIATE_SIZE,
      INTERMEDIATE_SIZE,
    ]);
  });

  test("skips a video that has no current frame, and stays scheduled", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.state.readyState = HAVE_CURRENT_DATA - 1;
    video.fireFrame();
    expect(offers).toHaveLength(0);

    // A camera that is still opening will have a frame shortly, so the loop
    // waits rather than tearing itself down.
    video.state.readyState = HAVE_CURRENT_DATA;
    video.fireFrame();
    expect(offers).toHaveLength(1);
    sampler.stop();
  });
});

describe("frame sampler animation frame fallback", () => {
  test("rides the animation frame when the video cannot drive the loop", () => {
    const animationFrame = stubAnimationFrame();
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo({ drivesLoop: false });
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    expect(animationFrame.pendingCount()).toBe(1);
    video.presentFrame();
    animationFrame.fireFrame();
    expect(offers).toHaveLength(1);

    sampler.stop();
    expect(animationFrame.pendingCount()).toBe(0);
  });

  test("skips a paused stream instead of resampling a frozen picture", () => {
    const animationFrame = stubAnimationFrame();
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo({ drivesLoop: false });
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.state.paused = true;
    video.presentFrame();
    animationFrame.fireFrame();
    video.state.paused = false;
    video.state.ended = true;
    video.presentFrame();
    animationFrame.fireFrame();
    // Identical grids with advancing timestamps read as a perfectly settled
    // scene, and the gate would keep one on every heartbeat.
    expect(offers).toHaveLength(0);

    video.state.ended = false;
    video.presentFrame();
    animationFrame.fireFrame();
    expect(offers).toHaveLength(1);
    sampler.stop();
  });

  test("samples a presented frame once, however many display frames it spans", () => {
    const animationFrame = stubAnimationFrame();
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo({ drivesLoop: false });
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.presentFrame();
    animationFrame.fireFrame();
    animationFrame.fireFrame();
    // A 24 or 30 fps stream on a 60 Hz display lands here on every other tick.
    // The repeat would score zero motion against its own twin, and the settle
    // check would read a panning camera as steady and keep a smeared frame.
    expect(offers).toHaveLength(1);
    // Declining to sample is not declining to run: the loop has to be waiting
    // when the next picture arrives.
    expect(animationFrame.pendingCount()).toBe(1);

    video.presentFrame();
    animationFrame.fireFrame();
    expect(offers).toHaveLength(2);
    sampler.stop();
  });

  test("samples the first frame after a restart even at the same position", () => {
    const animationFrame = stubAnimationFrame();
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo({ drivesLoop: false });
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    video.presentFrame();
    animationFrame.fireFrame();
    expect(offers).toHaveLength(1);

    // A restart means a different stream, so the position it happens to report
    // says nothing about whether the picture is one already seen.
    sampler.start(video.element);
    animationFrame.fireFrame();
    expect(offers).toHaveLength(2);
    sampler.stop();
  });
});

describe("frame sampler visibility", () => {
  test("suspends while the page is hidden and resumes when it returns", () => {
    const { gate, offers } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    expect(video.pendingCount()).toBe(1);

    setVisibility("hidden");
    expect(video.pendingCount()).toBe(0);

    setVisibility("visible");
    expect(video.pendingCount()).toBe(1);
    video.fireFrame();
    expect(offers).toHaveLength(1);
    sampler.stop();
  });

  test("does not resume a stopped sampler", () => {
    const { gate } = createRecordingGate();
    const video = createFakeVideo();
    const sampler = createFrameSampler({ gate, onDecision: () => {} });

    sampler.start(video.element);
    sampler.stop();

    setVisibility("hidden");
    setVisibility("visible");
    expect(video.pendingCount()).toBe(0);
  });
});
