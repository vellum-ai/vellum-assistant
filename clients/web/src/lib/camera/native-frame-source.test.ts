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
  NATIVE_CAPTURE_SLOT_RELEASE_MS,
  type NativeFrameSourceOptions,
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
    armForcedKeep() {},
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
  for (let turn = 0; turn < 20; turn++) {
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
  /** Captures outstanding right now. */
  inFlight(): number;
  /** The most that were ever outstanding at once. */
  maxConcurrent(): number;
}

/**
 * Every stub built by a case, so the shared bridge queue can be drained.
 *
 * The queue is module scope in the source, which is the point of it: the
 * plugin has one callback and every instance shares it. A case that leaves a
 * capture in flight would leave the queue blocked for every case after it, so
 * the teardown releases what the case held.
 */
let captureStubs: CaptureStub[] = [];

function createCaptureStub(): CaptureStub {
  let calls = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  let sample = btoa("jpeg-bytes");
  let held: ((value: string | null) => void) | null = null;
  let holdNext = false;
  let rejectNext = false;
  let emptyNext = false;
  let latency = 0;
  let latencyOnce: number | null = null;

  /** Count this call as outstanding until its promise settles. */
  function tracked(promise: Promise<string | null>): Promise<string | null> {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    return promise.then(
      (value) => {
        inFlight -= 1;
        return value;
      },
      (err: unknown) => {
        inFlight -= 1;
        throw err;
      },
    );
  }

  const stub: CaptureStub = {
    captureSample: () => {
      calls += 1;
      if (rejectNext) {
        rejectNext = false;
        return tracked(Promise.reject(new Error("camera stopping")));
      }
      if (emptyNext) {
        emptyNext = false;
        return tracked(Promise.resolve(null));
      }
      if (holdNext) {
        holdNext = false;
        return tracked(
          new Promise<string | null>((resolve) => {
            held = resolve;
          }),
        );
      }
      const takes = latencyOnce ?? latency;
      latencyOnce = null;
      if (takes > 0) {
        return tracked(
          new Promise<string | null>((resolve) => {
            setTimeout(() => resolve(sample), takes);
          }),
        );
      }
      return tracked(Promise.resolve(sample));
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
    inFlight: () => inFlight,
    maxConcurrent: () => maxConcurrent,
  };
  captureStubs.push(stub);
  return stub;
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

afterEach(async () => {
  // Free the shared bridge queue before the next case, whatever this one left
  // on it. Nothing in the source clears it, deliberately: see `captureSlot`.
  for (const stub of captureStubs) {
    stub.releaseHeld();
  }
  await settle();
  captureStubs = [];
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

    const debug = spyOn(console, "debug").mockImplementation(() => {});
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
    // second sample. Nothing is offered from it: the primer was requested two
    // seconds ago, so the pair is far outside the motion window and discarded
    // exactly as any other too-wide pair is.
    capture.releaseHeld();
    await settle();
    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(offers).toHaveLength(0);

    // The poll is not wedged by the ticks it dropped or by the pair it threw
    // away: the next one is whole and lands inside the window.
    await pollTimes(1);
    expect(capture.callCount()).toBe(4);
    expect(offers).toHaveLength(1);
    debug.mockRestore();
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

  test("queues a new run's sample behind a stranded one rather than beside it", async () => {
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
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    source.stop();
    source.start();
    await pollTimes(1);

    // The stranded sample holds its own run's claim, not the source's, so the
    // new run's tick is not dropped on arrival. What it cannot do is reach the
    // bridge: the plugin has one capture callback and the stranded call still
    // owns it, so issuing beside it would overwrite what it is waiting on.
    expect(capture.callCount()).toBe(1);
    expect(capture.maxConcurrent()).toBe(1);

    // The moment the stranded call settles, the queued one is issued.
    capture.releaseHeld();
    await settle();
    expect(capture.callCount()).toBe(2);
    expect(capture.maxConcurrent()).toBe(1);
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

  test("counts a slow first capture against the gap it could have caused", async () => {
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

    // The primer's bridge call takes 100ms and the judged frame's is instant.
    // Stamped at their answers, this pair would measure a gap of roughly zero
    // while its two pictures could be 100ms apart.
    source.start();
    capture.latencyNext(100);
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    await advanceInSteps(100);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);

    expect(observed).toHaveLength(1);
    expect(offers).toHaveLength(1);
    // The primer's own latency is inside the measured gap, because its picture
    // could have been taken at the moment it was requested. Stamped at the
    // answer instead, this difference is about zero.
    const gapMs = offers[0]!.nowMs - observed[0]!.nowMs;
    expect(gapMs).toBeGreaterThanOrEqual(100);
    // And still offered, because 100 is a bound the window can hold: the two
    // pictures cannot have been further apart than that.
    expect(gapMs).toBeLessThanOrEqual(NATIVE_PAIR_MAX_GAP_MS);
    source.stop();
  });

  test("discards a pair a slow first capture pushed outside the window", async () => {
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

    // Long enough on its own to put the two pictures further apart than the
    // window can hold. Measured from the answer this reads as a fast pair and
    // a moving frame is kept as settled, which is the whole failure.
    source.start();
    capture.latencyNext(NATIVE_PAIR_MAX_GAP_MS + 10);
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    await advanceInSteps(NATIVE_PAIR_MAX_GAP_MS + 10);
    await advanceInSteps(NATIVE_PAIR_SPACING_MS);

    expect(offers).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      "[native-frame-source] pair outside the motion window, skipped:",
      expect.objectContaining({ limitMs: NATIVE_PAIR_MAX_GAP_MS }),
    );
    debug.mockRestore();
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

/**
 * One bridge call at a time, whatever is asking.
 *
 * The plugin keeps a single capture callback on both platforms, so a second
 * request issued beside a first overwrites the slot the first is waiting on:
 * the older one never answers, or answers with the newer one's picture. Runs
 * and instances are both too narrow a scope for that, because an invalidate
 * and a source swap each leave a call running on the bridge.
 */
describe("native frame source bridge serialization", () => {
  function makeSource(
    capture: CaptureStub,
    decode: DecodeStub,
    onDecision: NativeFrameSourceOptions["onDecision"],
    intervalMs?: number,
  ) {
    return createNativeFrameSource({
      gate: createRecordingGate().gate,
      captureSample: capture.captureSample,
      onDecision,
      decode: decode.decode,
      now: () => clock,
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });
  }

  test("never lets two calls overlap, across a source the room replaced", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const older = makeSource(capture, decode, () => {});
    const newer = makeSource(capture, decode, () => {});

    older.start();
    capture.holdNext();
    await startPair();
    expect(capture.inFlight()).toBe(1);

    // What the room does on a preview swap: stop the old source with a call
    // still on the bridge and start a fresh one against the same plugin.
    older.stop();
    newer.start();
    await pollTimes(3);

    expect(capture.maxConcurrent()).toBe(1);
    expect(capture.callCount()).toBe(1);

    capture.releaseHeld();
    await settle();
    await pollTimes(1);

    // The new source samples once the bridge is free, and never beside the
    // call it was waiting on.
    expect(capture.maxConcurrent()).toBe(1);
    expect(capture.callCount()).toBeGreaterThan(1);
    newer.stop();
  });

  test("drops a queued sample whose run ended before the slot reached it", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const offers: FrameGateDecision[] = [];
    const source = makeSource(capture, decode, (decision) => {
      offers.push(decision);
    });

    // One call goes out and stays out.
    source.start();
    capture.holdNext();
    await startPair();
    expect(capture.callCount()).toBe(1);

    // A second run queues a sample behind it, then ends while it waits.
    source.stop();
    source.start();
    await pollTimes(1);
    expect(capture.callCount()).toBe(1);
    source.stop();

    capture.releaseHeld();
    await settle();

    // The queued sample belongs to a run whose camera may be closed, and a
    // request into a closed camera can wait forever on a queue with no
    // timeout. It leaves without touching the bridge instead, which is also
    // what keeps the slot free for whoever comes next.
    expect(capture.callCount()).toBe(1);

    source.start();
    await pollTimes(1);

    // The slot was not wedged: the camera reopens and sampling resumes.
    expect(capture.callCount()).toBe(3);
    expect(capture.maxConcurrent()).toBe(1);
    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("stamps a queued sample when it is issued, not when it was asked for", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const offers: FrameGateDecision[] = [];
    const stale = makeSource(capture, decode, () => {});
    const live = makeSource(capture, decode, (decision) => {
      offers.push(decision);
    });

    stale.start();
    capture.holdNext();
    await startPair();
    stale.stop();

    // The replacement's whole pair waits on a call that is going nowhere.
    live.start();
    await pollTimes(1);
    await advanceInSteps(500);
    expect(capture.callCount()).toBe(1);

    capture.releaseHeld();
    await settle();
    await pollTimes(1);

    // Dated from the moment it was enqueued, this pair's primer would carry a
    // gap of half a second and be thrown away. It is dated from the moment the
    // camera was actually asked, so the pair reads as what it is: two pictures
    // taken a spacing apart.
    expect(offers).toHaveLength(1);
    live.stop();
  });

  test("discards a pair whose second sample waited behind a stranded call", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const offers: FrameGateDecision[] = [];
    const sampling = makeSource(capture, decode, (decision) => {
      offers.push(decision);
    });
    const intruder = makeSource(capture, decode, () => {}, 20);

    // The pair's primer lands, and its second sample is a spacing away.
    sampling.start();
    await startPair();
    expect(capture.callCount()).toBe(1);

    // Another source takes the bridge inside that gap and holds it.
    intruder.start();
    capture.holdNext();
    await advanceInSteps(20);
    expect(capture.inFlight()).toBe(1);

    // The second sample comes due, queues, and waits half a second.
    await advanceInSteps(500);
    expect(capture.maxConcurrent()).toBe(1);
    capture.releaseHeld();
    await settle();

    // Its picture is now far from the primer's, and the bound says so: the
    // delay grows the measured gap, which discards, rather than shrinking it,
    // which would keep a moving frame as settled.
    expect(offers).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      "[native-frame-source] pair outside the motion window, skipped:",
      expect.objectContaining({ limitMs: NATIVE_PAIR_MAX_GAP_MS }),
    );
    debug.mockRestore();
    sampling.stop();
    intruder.stop();
  });
});

/**
 * The last resort under the queue.
 *
 * A call the camera never answers would otherwise hold the process-wide slot
 * for the life of the tab, and every source built after the camera reopened
 * would queue behind it: native Live silent for good. A call outstanding this
 * long is not a live one, so the queue lets go of it.
 */
describe("native frame source bridge deadline", () => {
  function makeSource(
    capture: CaptureStub,
    decode: DecodeStub,
    onDecision: NativeFrameSourceOptions["onDecision"],
  ) {
    return createNativeFrameSource({
      gate: createRecordingGate().gate,
      captureSample: capture.captureSample,
      onDecision,
      decode: decode.decode,
      now: () => clock,
    });
  }

  test("the deadline is far past any answer a pair could still use", () => {
    // Reachable only by a call that has stopped being a call: an answer this
    // late blows the pair's gap bound many times over, so letting go of it
    // costs no frame anyone could have kept.
    expect(NATIVE_CAPTURE_SLOT_RELEASE_MS).toBeGreaterThan(
      NATIVE_PAIR_MAX_GAP_MS * 50,
    );
    expect(NATIVE_CAPTURE_SLOT_RELEASE_MS).toBeGreaterThan(
      NATIVE_FRAME_SAMPLE_INTERVAL_MS * 5,
    );
  });

  test("arms no deadline over a call that answered", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const source = makeSource(capture, decode, () => {});

    source.start();
    await pollTimes(1);
    source.stop();

    // Long past when a deadline armed for those calls would have fired. An
    // answered call leaves nothing behind to go off later and report an
    // abandonment that did not happen.
    await advance(NATIVE_CAPTURE_SLOT_RELEASE_MS * 2);

    expect(debug).not.toHaveBeenCalledWith(
      "[native-frame-source] capture abandoned, releasing the bridge:",
      expect.anything(),
    );
    debug.mockRestore();
  });

  test("holds the bridge right up to the deadline", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const stalled = makeSource(capture, decode, () => {});
    const waiting = makeSource(capture, decode, () => {});

    stalled.start();
    capture.holdNext();
    await startPair();
    // The deadline runs from the moment the call was issued, not from here.
    const issuedAt = clock;
    expect(capture.callCount()).toBe(1);

    // The camera goes away under the request, and a replacement source starts.
    stalled.stop();
    waiting.start();
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    expect(capture.callCount()).toBe(1);

    await advance(NATIVE_CAPTURE_SLOT_RELEASE_MS - (clock - issuedAt) - 1);

    // Still waiting: a call that may yet answer is not raced by a second one.
    expect(capture.callCount()).toBe(1);
    expect(debug).not.toHaveBeenCalledWith(
      "[native-frame-source] capture abandoned, releasing the bridge:",
      expect.anything(),
    );
    debug.mockRestore();
    waiting.stop();
  });

  test("lets go at the deadline, and the next run samples", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const offers: FrameGateDecision[] = [];
    const stalled = makeSource(capture, decode, () => {});
    const live = makeSource(capture, decode, (decision) => {
      offers.push(decision);
    });

    stalled.start();
    capture.holdNext();
    await startPair();
    stalled.stop();

    // The camera comes back and Live is started again.
    live.start();
    await advance(NATIVE_CAPTURE_SLOT_RELEASE_MS + 1);
    await pollTimes(1);

    expect(debug).toHaveBeenCalledWith(
      "[native-frame-source] capture abandoned, releasing the bridge:",
      expect.objectContaining({ afterMs: NATIVE_CAPTURE_SLOT_RELEASE_MS }),
    );
    // Sampling again, which without the deadline it never would be.
    expect(offers).toHaveLength(1);

    // The one time two calls are outstanding at once, and it is sanctioned:
    // the older one has been given up on, so whatever it eventually does
    // reaches nobody, and the platforms hand the next frame to the newer call.
    expect(capture.maxConcurrent()).toBe(2);
    debug.mockRestore();
    live.stop();
  });

  test("abandoning one call disturbs neither a live run nor a decode in flight", async () => {
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const offers: FrameGateDecision[] = [];
    const stalled = makeSource(capture, decode, () => {});
    const live = makeSource(capture, decode, (decision) => {
      offers.push(decision);
    });

    // A decode is in flight for the live source when the abandonment happens.
    live.start();
    decode.holdNext();
    await startPair();
    expect(decode.decodeCount()).toBe(1);

    stalled.start();
    capture.holdNext();
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    stalled.stop();

    await advance(NATIVE_CAPTURE_SLOT_RELEASE_MS + 1);
    decode.releaseHeld();
    await settle();

    // The held decode finished and freed its image: the deadline reaches the
    // bridge queue and nothing else.
    expect(decode.releaseCount()).toBeGreaterThan(0);

    // And the live run is still the current one, so its next pair is judged.
    await pollTimes(1);
    expect(offers).toHaveLength(1);
    debug.mockRestore();
    live.stop();
  });
});

/**
 * The out-of-cycle sample.
 *
 * A poll a second apart answers a question asked now with a frame that can be
 * most of a second old, so the owner can ask for one at once. What matters is
 * that asking changes nothing else: the pair, the bridge queue, the generation
 * checks and the cadence behind it are the ones every tick uses, because a lone
 * capture would reach the gate with no motion baseline and a second pair beside
 * a running one would race the plugin's single callback.
 */
describe("native frame source out-of-cycle sample", () => {
  test("takes a whole pair, and leaves the cadence running behind it", async () => {
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
    await advance(400);
    expect(capture.callCount()).toBe(0);

    source.sampleNow();
    await settle();
    // The primer first, exactly as a tick takes it: the offered frame needs
    // something recent to measure motion against.
    expect(capture.callCount()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(offers).toHaveLength(0);

    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.nowMs).toBe(460);

    // The poll is untouched by it: its own tick lands on schedule.
    await advance(NATIVE_FRAME_SAMPLE_INTERVAL_MS - 460);
    await finishPair();
    expect(capture.callCount()).toBe(4);
    expect(offers).toHaveLength(2);
    expect(capture.maxConcurrent()).toBe(1);
    source.stop();
  });

  test("is remembered while the run has a pair out, and answered when it settles", async () => {
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
    expect(capture.callCount()).toBe(1);

    // The claim spans the whole pair, so the gap between its two samples is
    // not a hole a second pair can be started in. The ask is kept instead.
    source.sampleNow();
    await settle();
    expect(capture.callCount()).toBe(1);

    // The outstanding pair closes, and the remembered ask takes its own pair
    // right behind it: the closing pair's captures predate the ask.
    await finishPair();
    expect(offers).toHaveLength(1);
    expect(capture.callCount()).toBe(3);

    await finishPair();
    expect(capture.callCount()).toBe(4);
    expect(offers).toHaveLength(2);
    expect(capture.maxConcurrent()).toBe(1);
    source.stop();
  });

  test("a pair in flight at the ask is judged plainly; the follow-up is the forced one", async () => {
    // The real gate, so what is asserted is the arm's time bound itself: the
    // in-flight pair's judged frame is stamped before the ask and must not
    // spend it, and the follow-up pair's frame is stamped after and must.
    const gate = createFrameGate({
      ...DEFAULT_FRAME_GATE_OPTIONS,
      warmupMs: 0,
    });
    gate.reset(0);
    const decisions: FrameGateDecision[] = [];
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (decision) => decisions.push(decision),
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    // Hold the primer's decode open, so the pair's two captures both land and
    // the pair is still unjudged when speech begins.
    decode.holdNext();
    await startPair();
    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(decisions).toHaveLength(0);

    // Speech starts. The hook arms the gate and nudges the source, and both
    // captures already on the books predate this moment.
    await advance(40);
    const askAtMs = clock;
    gate.armForcedKeep(askAtMs);
    source.sampleNow();

    decode.releaseHeld();
    await settle();
    // The stale pair judged by the ambient rules, not force-kept.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reason).toBe("first");

    // The follow-up pair, captured after the ask, spends the arm.
    await finishPair();
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.reason).toBe("forced");
    expect(capture.maxConcurrent()).toBe(1);
    source.stop();
  });

  test("a judged capture unresolved at the ask cannot spend the arm by answering late", async () => {
    // Codex's residual interval: the pair's second bridge request is issued
    // before the ask and still unresolved when speech begins. Its answer-time
    // stamp postdates the arm, but the picture predates it, and only the
    // request-time bound can tell the two apart.
    const gate = createFrameGate({
      ...DEFAULT_FRAME_GATE_OPTIONS,
      warmupMs: 0,
    });
    gate.reset(0);
    const decisions: FrameGateDecision[] = [];
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: (decision) => decisions.push(decision),
      decode: decode.decode,
      now: () => clock,
    });

    source.start();
    await startPair();
    expect(capture.callCount()).toBe(1);

    // The judged request goes out and hangs on the bridge.
    capture.holdNext();
    await finishPair();
    expect(capture.callCount()).toBe(2);
    expect(decisions).toHaveLength(0);

    // Speech starts while it is still unresolved.
    await advance(40);
    gate.armForcedKeep(clock);
    source.sampleNow();

    // The late answer lands after the arm. Judged plainly, arm intact.
    capture.releaseHeld();
    await settle();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reason).toBe("first");

    // The remembered follow-up, requested after the ask, spends it.
    await finishPair();
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.reason).toBe("forced");
    expect(capture.maxConcurrent()).toBe(1);
    source.stop();
  });

  test("drops a remembered ask with the run that made it", async () => {
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
    source.sampleNow();
    // A flip: the ask was about the camera that is gone, so no follow-up pair
    // is owed to it.
    source.invalidate();
    await finishPair();
    expect(capture.callCount()).toBe(1);

    // The next tick samples for itself, and only for itself.
    await startPair();
    await finishPair();
    await settle();
    expect(capture.callCount()).toBe(3);
    expect(offers).toHaveLength(1);
    source.stop();
  });

  test("a stop buries a remembered ask, restart owes it nothing", async () => {
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
    await startPair();
    source.sampleNow();
    source.stop();
    await finishPair();
    expect(capture.callCount()).toBe(1);

    source.start();
    await settle();
    // Nothing before the new cadence's own first tick.
    expect(capture.callCount()).toBe(1);
    source.stop();
  });

  test("samples nothing on a source that is not polling", async () => {
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

    // Before the first start there is no camera to ask, and after a stop the
    // one there was is being torn down.
    source.sampleNow();
    await settle();
    expect(capture.callCount()).toBe(0);

    source.start();
    source.stop();
    source.sampleNow();
    await settle();
    expect(capture.callCount()).toBe(0);
    expect(offers).toHaveLength(0);
  });
});
