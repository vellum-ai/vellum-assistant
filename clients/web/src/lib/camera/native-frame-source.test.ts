/**
 * Tests for the native frame source.
 *
 * The gate's own tests prove the decision and the sampler's prove the downscale
 * chain. These prove what is specific to polling a bridge: a tick that fires
 * while the last sample is still out, a sample that rejects because the camera
 * went away, a sample from a run that has ended arriving during the next one,
 * and a teardown that leaves nothing running.
 *
 * The canvas is faked for the same reason the sampler's tests fake it, so an
 * exact grid can be asserted. The decode is injected because no DOM
 * implementation outside a browser turns real JPEG bytes into a drawable image,
 * and a stub decoder still exercises the shared chain behind it.
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

import {
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

/** Advance past `count` poll intervals and let the samples they start finish. */
async function pollTimes(count: number): Promise<void> {
  jest.advanceTimersByTime(NATIVE_FRAME_SAMPLE_INTERVAL_MS * count);
  await settle();
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
}

function createCaptureStub(): CaptureStub {
  let calls = 0;
  let sample = btoa("jpeg-bytes");
  let held: ((value: string | null) => void) | null = null;
  let holdNext = false;
  let rejectNext = false;
  let emptyNext = false;

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
      return Promise.resolve(sample);
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

  return {
    decode: async () => {
      decodes += 1;
      if (holdNext) {
        holdNext = false;
        return new Promise<DecodedFrame>((resolve) => {
          held = resolve;
        });
      }
      return frame;
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
  readback = grayReadback((cell) => cell);
  canvasContexts = stubCanvasContexts(() => readback);
});

afterEach(() => {
  jest.useRealTimers();
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe("native frame source cadence", () => {
  test("takes one sample per interval and nothing before the first", async () => {
    const { gate, offers } = createRecordingGate();
    const capture = createCaptureStub();
    const decode = createDecodeStub();
    const source = createNativeFrameSource({
      gate,
      captureSample: capture.captureSample,
      onDecision: () => {},
      decode: decode.decode,
    });

    source.start();
    // Starting is not sampling: the camera has just opened and the first frame
    // is a poll away.
    await settle();
    expect(capture.callCount()).toBe(0);

    await pollTimes(3);
    expect(capture.callCount()).toBe(3);
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
      intervalMs: 250,
    });

    source.start();
    jest.advanceTimersByTime(NATIVE_FRAME_SAMPLE_INTERVAL_MS);
    await settle();
    expect(capture.callCount()).toBe(4);
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
    });

    source.start();
    jest.advanceTimersByTime(600);
    await settle();

    source.start();
    jest.advanceTimersByTime(400);
    await settle();
    // A restart is a new camera, and the first sample of one is a full
    // interval out rather than whatever was left of the last run's.
    expect(capture.callCount()).toBe(0);

    jest.advanceTimersByTime(600);
    await settle();
    expect(capture.callCount()).toBe(1);

    // Two intervals against one gate would double the bridge cost and hand the
    // gate two frames a millisecond apart.
    await pollTimes(1);
    expect(capture.callCount()).toBe(2);
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
    });

    source.start();
    await pollTimes(1);
    source.stop();

    const [intermediate, grid] = canvasContexts;
    // The decoded image goes to the intermediate canvas and the intermediate
    // canvas goes to the grid, which is the two-step area average the browser
    // path uses. Reading the image straight into 16x16 point samples it, and
    // the gate's thresholds were not calibrated on that.
    expect(intermediate!.drawn).toEqual([
      [decode.image, 0, 0, INTERMEDIATE_SIZE, INTERMEDIATE_SIZE],
    ]);
    expect(grid!.drawn).toEqual([
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
    });

    source.start();
    await pollTimes(2);
    expect(offers).toHaveLength(2);
    expect(decode.releaseCount()).toBe(2);

    // A decode that lands after the poll ended is judged by nobody, and the
    // image it produced still has to be freed.
    decode.holdNext();
    await pollTimes(1);
    source.stop();
    decode.releaseHeld();
    await settle();
    expect(offers).toHaveLength(2);
    expect(decode.releaseCount()).toBe(3);
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
    });

    source.start();
    capture.holdNext();
    await pollTimes(1);
    expect(capture.callCount()).toBe(1);

    // Two ticks pass while the first sample is still on the bridge. Letting
    // either through would queue a second capture behind the first.
    await pollTimes(2);
    expect(capture.callCount()).toBe(1);
    expect(offers).toHaveLength(0);

    capture.releaseHeld();
    await settle();
    expect(offers).toHaveLength(1);

    // The poll is not wedged by the tick it dropped.
    await pollTimes(1);
    expect(capture.callCount()).toBe(2);
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
    });

    source.start();
    capture.holdNext();
    await pollTimes(1);
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
    });

    source.start();
    decode.holdNext();
    await pollTimes(1);
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
    });

    source.start();
    capture.holdNext();
    await pollTimes(1);
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
    expect(capture.callCount()).toBe(2);
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
    });

    source.start();
    capture.holdNext();
    await pollTimes(1);
    expect(capture.callCount()).toBe(1);

    source.stop();
    source.start();
    await pollTimes(1);

    // The stranded sample holds its own run's claim, not the source's, so the
    // new run is not blind until a capture nobody is waiting for settles.
    expect(capture.callCount()).toBe(2);
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
    });

    source.start();
    await pollTimes(1);
    expect(offers).toHaveLength(1);

    source.stop();
    await pollTimes(3);
    expect(capture.callCount()).toBe(1);
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
    });

    source.stop();
    source.start();
    source.stop();
    source.stop();
    await pollTimes(2);
    expect(offers).toHaveLength(0);
  });
});
