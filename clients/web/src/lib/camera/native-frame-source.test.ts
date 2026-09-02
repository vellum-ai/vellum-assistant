/**
 * Tests for the native frame source.
 *
 * The gate's own tests prove the decision and the sampler's prove the downscale
 * chain. These prove what is specific to polling a bridge: a tick that takes a
 * pair so the frame it offers has a motion baseline, a tick that fires while
 * the last pair is still out, a sample that rejects because the camera went
 * away, a sample from a run that has ended arriving during the next one, and a
 * teardown that leaves nothing running.
 *
 * The canvas is faked for the same reason the sampler's tests fake it, so an
 * exact grid can be asserted. The decode is injected because no DOM
 * implementation outside a browser turns real JPEG bytes into a drawable image,
 * and a stub decoder still exercises the shared chain behind it. The clock is
 * injected because the thing under test is what the gate is told the time is:
 * a real one advances by microseconds while the fake timers jump a second.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";

import { FRAME_GATE_OVERRIDE_KEYS } from "./frame-gate-debug";
import {
  createFrameGate,
  DEFAULT_FRAME_GATE_OPTIONS,
  FRAME_GRID_CELLS,
  FRAME_GRID_SIZE,
  type FrameGate,
  type FrameGateDecision,
  type FrameGrid,
} from "./frame-gate";
import type { FrameSource } from "./frame-sampler";
import {
  createNativeFrameSource,
  NATIVE_FRAME_SAMPLE_INTERVAL_MS,
  NATIVE_PAIR_MAX_GAP_MS,
  NATIVE_PAIR_SPACING_MS,
  type DecodedFrame,
} from "./native-frame-source";

/** Side length of the shared downscale chain's intermediate canvas. */
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
  /** A snapshot, because the producer hands the same buffer over every time. */
  readonly cells: readonly number[];
  readonly nowMs: number;
}

function createRecordingGate(): {
  gate: FrameGate;
  offers: RecordedOffer[];
  /** Frames primed as a motion baseline, which never become decisions. */
  observed: RecordedOffer[];
} {
  const offers: RecordedOffer[] = [];
  const observed: RecordedOffer[] = [];
  const gate: FrameGate = {
    offer(grid, nowMs) {
      offers.push({ grid, cells: Array.from(grid), nowMs });
      return STUB_DECISION;
    },
    observe(grid, nowMs) {
      observed.push({ grid, cells: Array.from(grid), nowMs });
    },
    reset() {},
  };
  return { gate, offers, observed };
}

interface FakeContext {
  readonly canvas: HTMLCanvasElement;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  /** Argument lists of every `drawImage` call, in order. */
  readonly drawn: unknown[][];
  drawImage(...args: unknown[]): void;
  getImageData(): { data: Uint8ClampedArray };
}

const realGetContext = HTMLCanvasElement.prototype.getContext;

function stubCanvasContexts(readback: () => Uint8ClampedArray): FakeContext[] {
  const contexts: FakeContext[] = [];
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
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
    contexts.push(context);
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return contexts;
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

/**
 * Let every pending microtask run.
 *
 * A sample awaits the capture and then the decode, so the offer it produces is
 * several promise turns behind the timer that started it.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

/**
 * The clock the source stamps the gate with, advanced with the fake timers.
 *
 * Reset per case, so every case reads times from zero.
 */
let clock = 0;

/** Move both clocks, which is the only way they can be read as one. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  jest.advanceTimersByTime(ms);
  await settle();
}

/**
 * The same, a millisecond at a time.
 *
 * A single jump moves the clock to the END of the window before running the
 * timers inside it, so anything resolving partway through reads a later time
 * than it happened at. Cases that assert on a measured gap need the two to
 * stay in step; the rest do not pay for it.
 */
async function advanceInSteps(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed++) {
    clock += 1;
    jest.advanceTimersByTime(1);
  }
  await settle();
}

/**
 * Reach a tick and let its first sample land, leaving the pair open.
 *
 * The second sample is a pair spacing away, which is where a flip, a stop, or
 * an invalidate can land mid-pair.
 */
async function startPair(intervalMs = NATIVE_FRAME_SAMPLE_INTERVAL_MS) {
  await advance(intervalMs);
}

/** Close a pair {@link startPair} opened, which is what produces the offer. */
async function finishPair(): Promise<void> {
  await advance(NATIVE_PAIR_SPACING_MS);
}

/** Advance past `count` whole ticks, each taking its pair. */
async function pollTimes(count: number): Promise<void> {
  for (let tick = 0; tick < count; tick++) {
    await startPair();
    await finishPair();
  }
}

interface CaptureStub {
  /** What the source is constructed with. */
  readonly captureSample: () => Promise<string | null>;
  callCount(): number;
  /** Base64 the next capture resolves with. */
  setSample(base64: string): void;
  /** Hold the next capture open until {@link CaptureStub.releaseHeld}. */
  holdNext(): void;
  releaseHeld(): void;
  /** Reject the next capture, as a camera being torn down does. */
  rejectNext(): void;
  /** Resolve the next capture with nothing, as a stopped camera does. */
  emptyNext(): void;
  /**
   * Make every capture take this long, as a slow bridge does.
   *
   * Spent on the fake timers, so a case advances through it and the clock the
   * source stamps with moves by the same amount.
   */
  setLatency(ms: number): void;
  /** The same, for the next capture only. */
  latencyNext(ms: number): void;
}

function createCaptureStub(): CaptureStub {
  let calls = 0;
  let sample = btoa("jpeg-bytes");
  let held: ((value: string | null) => void) | null = null;
  let holdNext = false;
  let rejectNext = false;
  let emptyNext = false;
  let latency = 0;
  let latencyOnce: number | null = null;

  return {
    captureSample: () => {
      calls += 1;
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("camera stopping"));
      }
      if (emptyNext) {
        emptyNext = false;
        return Promise.resolve(null);
      }
      if (holdNext) {
        holdNext = false;
        return new Promise<string | null>((resolve) => {
          held = resolve;
        });
      }
      const takes = latencyOnce ?? latency;
      latencyOnce = null;
      if (takes > 0) {
        return new Promise<string | null>((resolve) => {
          setTimeout(() => resolve(sample), takes);
        });
      }
      return Promise.resolve(sample);
    },
    setLatency(ms) {
      latency = ms;
    },
    latencyNext(ms) {
      latencyOnce = ms;
    },
    callCount: () => calls,
    setSample(next) {
      sample = next;
    },
    holdNext() {
      holdNext = true;
    },
    releaseHeld() {
      held?.(sample);
      held = null;
    },
    rejectNext() {
      rejectNext = true;
    },
    emptyNext() {
      emptyNext = true;
    },
  };
}

interface DecodeStub {
  readonly decode: (blob: Blob) => Promise<DecodedFrame | null>;
  /** The stand-in image every decode resolves with. */
  readonly image: FrameSource;
  releaseCount(): number;
  decodeCount(): number;
  /** Hold the next decode open until {@link DecodeStub.releaseHeld}. */
  holdNext(): void;
  releaseHeld(): void;
  /** Make every decode take this long, on the fake timers. */
  setLatency(ms: number): void;
}

function createDecodeStub(): DecodeStub {
  const image = { decoded: true } as unknown as FrameSource;
  let releases = 0;
  let decodes = 0;
  let holdNext = false;
  let held: ((frame: DecodedFrame) => void) | null = null;

  const frame: DecodedFrame = {
    image,
    release() {
      releases += 1;
    },
  };

  let latency = 0;

  return {
    decode: async () => {
      decodes += 1;
      if (holdNext) {
        holdNext = false;
        return new Promise<DecodedFrame>((resolve) => {
          held = resolve;
        });
      }
      if (latency > 0) {
        return new Promise<DecodedFrame>((resolve) => {
          setTimeout(() => resolve(frame), latency);
        });
      }
      return frame;
    },
    setLatency(ms) {
      latency = ms;
    },
    image,
    releaseCount: () => releases,
    decodeCount: () => decodes,
    holdNext() {
      holdNext = true;
    },
    releaseHeld() {
      held?.(frame);
      held = null;
    },
  };
}

let readback: Uint8ClampedArray;
let canvasContexts: FakeContext[];

beforeEach(() => {
  jest.useFakeTimers();
  clock = 0;
  readback = grayReadback((cell) => cell);
  canvasContexts = stubCanvasContexts(() => readback);
});

afterEach(() => {
  jest.useRealTimers();
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe("native frame source cadence", () => {
  test("takes one pair per interval and nothing before the first", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    // Starting is not sampling: the camera has just opened and the first frame
    // is a poll away.
    await settle();
    expect(capture.callCount()).toBe(0);

    // The first sample of a tick primes the motion baseline and is never
    // judged; the second is the one offered.
    await startPair();
    expect(capture.callCount()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(offers).toHaveLength(0);

    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(observed).toHaveLength(1);
    expect(offers).toHaveLength(1);

    await pollTimes(2);
    expect(capture.callCount()).toBe(6);
    expect(observed).toHaveLength(3);
    expect(offers).toHaveLength(3);
    source.stop();
  });

  test("honors a caller's interval", async () => {
    const { gate } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
      intervalMs: 250,
    });

    source.start();
    await advance(249);
    expect(capture.callCount()).toBe(0);

    await startPair(1);
    await finishPair();
    expect(capture.callCount()).toBe(2);
    source.stop();
  });

  test("restarting resets the cadence and leaves one poll running", async () => {
    const { gate } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await advance(600);

    source.start();
    await advance(400);
    // A restart is a new camera, and the first sample of one is a full
    // interval out rather than whatever was left of the last run's.
    expect(capture.callCount()).toBe(0);

    await advance(600);
    expect(capture.callCount()).toBe(1);
    await finishPair();
    expect(capture.callCount()).toBe(2);

    // Two intervals against one gate would double the bridge cost and hand the
    // gate two pairs a millisecond apart.
    await pollTimes(1);
    expect(capture.callCount()).toBe(4);
    source.stop();
  });
});

describe("native frame source grid production", () => {
  test("draws the decoded sample through the shared downscale chain", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await pollTimes(1);
    source.stop();

    const [intermediate, grid] = canvasContexts;
    // The decoded image goes to the intermediate canvas and the intermediate
    // canvas goes to the grid, which is the two-step area average the browser
    // path uses. Reading the image straight into 16x16 point samples it, and
    // the gate's thresholds were not calibrated on that. Both frames of the
    // pair go through it, so the primer and the judged frame are comparable.
    expect(intermediate!.drawn).toEqual([
      [decode.image, 0, 0, INTERMEDIATE_SIZE, INTERMEDIATE_SIZE],
      [decode.image, 0, 0, INTERMEDIATE_SIZE, INTERMEDIATE_SIZE],
    ]);
    expect(grid!.drawn).toEqual([
      [intermediate!.canvas, 0, 0, FRAME_GRID_SIZE, FRAME_GRID_SIZE],
      [intermediate!.canvas, 0, 0, FRAME_GRID_SIZE, FRAME_GRID_SIZE],
    ]);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.cells).toEqual(
      Array.from({ length: FRAME_GRID_CELLS }, (_unused, cell) => cell),
    );
  });

  test("offers the exact JPEG the decision was made on", async () => {
    const { gate } = createRecordingGate();
    const capture = createCaptureStub();
    capture.setSample(btoa("first-sample"));
    const decode = createDecodeStub();
    const samples: Blob[] = [];
    const decisions: FrameGateDecision[] = [];
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (decision, _nowMs, sample) => {
        decisions.push(decision);
        samples.push(sample);
      },
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await pollTimes(1);
    source.stop();

    expect(decisions).toEqual([STUB_DECISION]);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.type).toBe("image/jpeg");
    // A keep persists this blob rather than capturing again, so the frame the
    // gate judged and the frame the conversation gets are the same picture.
    expect(await samples[0]!.text()).toBe("first-sample");
  });

  test("accepts a data URI as well as bare base64", async () => {
    const { gate } = createRecordingGate();
    const capture = createCaptureStub();
    capture.setSample(`data:image/jpeg;base64,${btoa("uri-sample")}`);
    const decode = createDecodeStub();
    const samples: Blob[] = [];
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (_decision, _nowMs, sample) => {
        samples.push(sample);
      },
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await pollTimes(1);
    source.stop();

    expect(await samples[0]!.text()).toBe("uri-sample");
  });

  test("releases the decode whether or not it produced an offer", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await pollTimes(2);
    expect(offers).toHaveLength(2);
    // Both frames of both pairs: the primer is decoded and freed like any
    // other, it just never reaches a decision.
    expect(decode.releaseCount()).toBe(4);

    // A decode that lands after the poll ended is judged by nobody, and the
    // image it produced still has to be freed.
    decode.holdNext();
    await startPair();
    source.stop();
    decode.releaseHeld();
    await settle();
    expect(offers).toHaveLength(2);
    expect(decode.releaseCount()).toBe(5);
  });
});

describe("native frame source overlap", () => {
  test("drops a tick that fires while a sample is still out", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    // Two ticks pass while the pair's first sample is still on the bridge.
    // Letting either through would queue a second capture behind it, and the
    // claim covers the whole pair rather than one sample of it.
    await pollTimes(2);
    expect(capture.callCount()).toBe(1);
    expect(offers).toHaveLength(0);

    // Releasing it resumes the pair the tick opened, which still owes its
    // second sample a spacing later.
    capture.releaseHeld();
    await settle();
    expect(offers).toHaveLength(0);
    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(offers).toHaveLength(1);

    // The poll is not wedged by the ticks it dropped.
    await pollTimes(1);
    expect(capture.callCount()).toBe(4);
    expect(offers).toHaveLength(2);
    source.stop();
  });
});

describe("native frame source failure tolerance", () => {
  test("keeps polling after a capture rejects", async () => {
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.rejectNext();
    await pollTimes(1);
    expect(offers).toHaveLength(0);
    // A stop or a flip rejects whatever sample is in the air, and the camera
    // that replaces it is one tick away.
    expect(decode.decodeCount()).toBe(0);

    await pollTimes(1);
    expect(offers).toHaveLength(1);
    source.stop();
    debug.mockRestore();
  });

  test("keeps polling after a capture answers with nothing", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.emptyNext();
    await pollTimes(1);
    expect(offers).toHaveLength(0);
    expect(decode.decodeCount()).toBe(0);

    await pollTimes(1);
    expect(offers).toHaveLength(1);
    source.stop();
  });
});

describe("native frame source run generation", () => {
  test("refuses a capture from a run that ended before it landed", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    source.stop();
    source.start();
    capture.releaseHeld();
    await settle();

    // The camera that sample was taken from has been stopped and reopened, so
    // it is a view of a scene the user has already turned away from. Scoring
    // the new run's first frame against it is a motion reading of a cut.
    expect(offers).toHaveLength(0);
    expect(decode.decodeCount()).toBe(0);
    source.stop();
  });

  test("refuses a decode from a run that ended before it landed", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    decode.holdNext();
    await startPair();
    expect(decode.decodeCount()).toBe(1);

    source.stop();
    source.start();
    decode.releaseHeld();
    await settle();

    // A run can also end inside the decode, which is the second await this
    // frame crosses.
    expect(offers).toHaveLength(0);
    // Refused is not leaked: the image it decoded is still freed.
    expect(decode.releaseCount()).toBe(1);
    source.stop();
  });

  test("refuses a capture the owner invalidated while it was in flight", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    // The camera flipped while that sample was on the bridge. Its bytes are of
    // the view the user just turned away from, and every guard downstream reads
    // the world as it is when a frame is OFFERED, which is now.
    source.invalidate();
    capture.releaseHeld();
    await settle();

    expect(offers).toHaveLength(0);
    expect(decode.decodeCount()).toBe(0);

    // The cadence is untouched: the replacement camera is one tick away, not
    // one restart away.
    await pollTimes(1);
    expect(capture.callCount()).toBe(3);
    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("refuses a decode the owner invalidated while it was in flight", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    decode.holdNext();
    await pollTimes(1);
    expect(decode.decodeCount()).toBe(1);

    // The change can also land inside the decode, which is the second await a
    // sample crosses before anyone sees it.
    source.invalidate();
    decode.releaseHeld();
    await settle();

    expect(offers).toHaveLength(0);
    expect(decode.releaseCount()).toBe(1);

    await pollTimes(1);
    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("samples on the first tick of a run started over a stranded sample", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    source.stop();
    source.start();
    await pollTimes(1);

    // The stranded sample holds its own run's claim, not the source's, so the
    // new run is not blind until a capture nobody is waiting for settles.
    expect(capture.callCount()).toBe(3);
    expect(offers).toHaveLength(1);
    source.stop();
  });
});

describe("native frame source cleanup", () => {
  test("stops polling", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await pollTimes(1);
    expect(offers).toHaveLength(1);

    source.stop();
    await pollTimes(3);
    expect(capture.callCount()).toBe(2);
    expect(offers).toHaveLength(1);
  });

  test("stops idempotently", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.stop();
    source.start();
    source.stop();
    source.stop();
    await pollTimes(2);
    expect(offers).toHaveLength(0);
  });
});

/**
 * The reason a tick takes two samples.
 *
 * These run the REAL gate rather than the recording stub, because what is under
 * test is a decision: whether the settle check can still reject a frame taken
 * mid-pan. Only the two thresholds the poll cadence would otherwise decide are
 * moved, so the settle threshold under test is the shipped one.
 */
describe("native frame source motion pairing", () => {
  function panTuning() {
    return {
      ...DEFAULT_FRAME_GATE_OPTIONS,
      // A camera that just opened, and a rate floor that has already elapsed.
      // Both would otherwise reject before the settle check is reached.
      warmupMs: 0,
      minIntervalMs: 0,
    };
  }

  test("the pair spacing fits inside the gate's motion window", () => {
    // Past the window the gate reports no motion at all and the pair buys
    // nothing. Half of it leaves the second capture's own bridge and decode
    // latency room to vary without pushing the pair outside.
    expect(NATIVE_PAIR_SPACING_MS).toBeGreaterThan(0);
    expect(NATIVE_PAIR_SPACING_MS).toBeLessThan(
      DEFAULT_FRAME_GATE_OPTIONS.motionMaxAgeMs,
    );
  });

  test("rejects a panned frame and keeps a settled one, at a poll a second", async () => {
    const gate = createFrameGate(panTuning());
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const decisions: FrameGateDecision[] = [];
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (decision) => {
        decisions.push(decision);
      },
      decode: decode.decode,
      now: () => clock,
    });

    source.start();

    // A pan. The frame offered looks nothing like the one taken a pair spacing
    // before it, which is a camera in motion and so a smeared picture.
    readback = grayReadback((cell) => cell);
    await startPair();
    readback = grayReadback((cell) => 255 - cell);
    await finishPair();

    expect(decisions).toHaveLength(1);
    // Without the primer this is null, the settle check never runs, and the
    // frame is kept: a blurred view of a room the user is still turning past,
    // uploaded and persisted as what the call is being shown.
    expect(decisions[0]!.motion).not.toBeNull();
    expect(decisions[0]!.keep).toBe(false);
    expect(decisions[0]!.reason).toBe("moving");

    // The camera comes to rest: both frames of the pair are the same view, a
    // whole poll interval after the pan.
    await startPair();
    await finishPair();

    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.motion).toBe(0);
    expect(decisions[1]!.keep).toBe(true);
  });

  test("offers nothing when the pair's second sample fails", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    expect(observed).toHaveLength(1);

    capture.emptyNext();
    await finishPair();

    // Never the primer as a fallback. It has no baseline of its own, so
    // offering it is exactly the blind keep the pair exists to stop.
    expect(offers).toHaveLength(0);

    await pollTimes(1);
    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("abandons the pair when the camera flips between its two samples", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    expect(observed).toHaveLength(1);

    source.invalidate();
    await finishPair();

    // The primer describes the camera that is gone, so a frame scored against
    // it is a motion reading of a cut. The second sample is not even taken.
    expect(offers).toHaveLength(0);
    expect(capture.callCount()).toBe(1);

    // The next tick opens a whole pair against the camera that is there now.
    await pollTimes(1);
    expect(offers).toHaveLength(1);
    expect(capture.callCount()).toBe(3);
    source.stop();
  });

  test("abandons the pair when the poll stops between its two samples", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    expect(observed).toHaveLength(1);

    source.stop();
    await finishPair();

    expect(offers).toHaveLength(0);
    expect(capture.callCount()).toBe(1);
  });
});

/**
 * What the gate is told the time is.
 *
 * The pair only buys a motion reading if the two frames land inside the gate's
 * window, and what sits between them on a real handset is latency: a bridge
 * call, a JPEG decode. These drive both with the fake clock, because the whole
 * point of the pair is a number measured in milliseconds and a real clock in a
 * test moves by microseconds.
 */
describe("native frame source pair timing", () => {
  function fastPairOptions() {
    return {
      ...DEFAULT_FRAME_GATE_OPTIONS,
      warmupMs: 0,
      minIntervalMs: 0,
    };
  }

  test("reads the motion window from the shipped options, which no slider moves", () => {
    // The source knows the window without holding the gate's configuration,
    // which is only sound while the window is not one of the tunable
    // thresholds. Make that a failing test rather than a stale comment.
    expect(FRAME_GATE_OVERRIDE_KEYS).not.toContain("motionMaxAgeMs");
    expect(NATIVE_PAIR_MAX_GAP_MS).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.motionMaxAgeMs,
    );
  });

  test("stamps both frames of the pair at capture, not at decode", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    // Four times the whole motion window, on both frames.
    decode.setLatency(NATIVE_PAIR_MAX_GAP_MS * 2);
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS * 2);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS * 2);

    expect(observed).toHaveLength(1);
    expect(offers).toHaveLength(1);
    // The two pictures were taken exactly a spacing apart. The decodes that
    // followed them took far longer than the window, and neither one is in
    // this number: that is the whole difference between a stamp at capture and
    // a stamp at decode, and it is what keeps the gap inside the window on
    // hardware slow enough to need the check.
    expect(offers[0]!.nowMs - observed[0]!.nowMs).toBe(NATIVE_PAIR_SPACING_MS);
  });

  test("a slow decode does not cost the pair its motion reading", async () => {
    const gate = createFrameGate(fastPairOptions());
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    // Longer than the whole motion window. Stamped after the decode, or
    // decoded before the second capture was even asked for, this pair would
    // measure well outside the window and be discarded.
    decode.setLatency(NATIVE_PAIR_MAX_GAP_MS * 2);
    const decisions: FrameGateDecision[] = [];
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (decision) => {
        decisions.push(decision);
      },
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    // Both captures land first, a spacing apart, while nothing has decoded.
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);

    // Then the decodes finish, far later than the window, and each reads the
    // view its capture held: the camera panned between the two.
    readback = grayReadback((cell) => cell);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS * 2);
    readback = grayReadback((cell) => 255 - cell);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS * 2);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.motion).not.toBeNull();
    expect(decisions[0]!.keep).toBe(false);
    expect(decisions[0]!.reason).toBe("moving");
    source.stop();
  });

  test("discards a pair whose second capture landed outside the window", async () => {
    const { gate, offers, observed } = createRecordingGate();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    expect(observed).toHaveLength(1);

    // A bridge slow enough that the two pictures are further apart than the
    // window. Offering the second would hand the gate a motion of null, skip
    // the settle check, and make a mid-pan frame keepable on novelty alone.
    capture.latencyNext(NATIVE_PAIR_MAX_GAP_MS);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS);

    expect(offers).toHaveLength(0);
    // The gap it measured is logged, which is the number a device test reports.
    expect(debug).toHaveBeenCalledWith(
      "[native-frame-source] pair outside the motion window, skipped:",
      expect.objectContaining({ limitMs: NATIVE_PAIR_MAX_GAP_MS }),
    );
    debug.mockRestore();
    source.stop();
  });

  test("a bridge inside the window still offers", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();

    // The same shape as the case above with a bridge fast enough to fit: the
    // discard is about the measured gap, not about latency existing.
    capture.latencyNext(NATIVE_PAIR_MAX_GAP_MS - NATIVE_PAIR_SPACING_MS - 1);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS);

    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("recovers on the next tick once the bridge speeds up", async () => {
    const { gate, offers } = createRecordingGate();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    capture.latencyNext(NATIVE_PAIR_MAX_GAP_MS);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS);
    expect(offers).toHaveLength(0);

    // A discarded pair costs its tick and nothing else.
    await pollTimes(1);
    expect(offers).toHaveLength(1);
    debug.mockRestore();
    source.stop();
  });
});
