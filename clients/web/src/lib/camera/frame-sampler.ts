/**
 * The web half of live vision: turns a live `<video>` into the luma grids the
 * frame gate decides on.
 *
 * The gate never sees an image, only a 16x16 grid of luma bytes and a
 * timestamp. Producing that grid from a browser stream is this module's whole
 * job, and it is deliberately the only place the web path touches a canvas:
 * the iOS sampler strides the same grid out of an `AVCaptureVideoDataOutput`
 * buffer in Swift, and the two must agree byte for byte or a threshold tuned in
 * a browser means something different on a phone.
 *
 * ## Why the downscale happens twice
 *
 * A 1280x720 frame reduced straight to 16x16 is a factor of roughly 120 in one
 * step, and browser scalers degrade toward point sampling well before that.
 * Point sampling reads single source pixels rather than averaging regions, so
 * sub-pixel hand shake moves whole cells and the frames of a motionless camera
 * stop resembling each other. Measured against a still handheld clip that
 * inflated the gate's motion score about sixfold, which is most of the margin
 * the settle check runs on. Going through an intermediate canvas keeps each
 * step inside the range where the scaler still averages, and the resulting grid
 * is an area average of the frame, which is what the iOS path produces and what
 * the gate's thresholds were calibrated on.
 *
 * ## Why the loop prefers `requestVideoFrameCallback`
 *
 * It fires once per frame the compositor actually receives. A 24 fps stream
 * costs 24 ticks a second instead of the animation frame's 60, a stalled camera
 * costs none, and no tick ever samples the same picture twice. Where the method
 * is missing the animation frame stands in, and both duplicate-sample guards in
 * `sampleFrame` exist purely to cover that case: a loop paced by the display
 * rather than the camera sees the same picture repeatedly, and a repeat is a
 * zero-motion frame that makes a moving camera look settled.
 *
 * ## What this module does not do
 *
 * - It does not acquire or release the camera. It is handed a `<video>` that is
 *   already playing and forgets it on {@link FrameSampler.stop}.
 * - It does not call {@link FrameGate.reset}. A camera flip or a stream swap
 *   invalidates the gate's comparison history, and only the owner of the stream
 *   knows one happened.
 * - It does not encode or upload anything. It reports a decision and the owner
 *   decides what a keep is worth.
 */

import {
  FRAME_GRID_CELLS,
  FRAME_GRID_SIZE,
  type FrameGate,
  type FrameGateDecision,
} from "./frame-gate";

/**
 * Side length of the intermediate canvas, in pixels.
 *
 * Four cells per grid cell: small enough that the first draw does most of the
 * reduction, large enough that the second draw still averages a 4x4 block
 * rather than picking one pixel out of it.
 */
const INTERMEDIATE_SIZE = FRAME_GRID_SIZE * 4;

/**
 * The `readyState` at which a video holds a frame that can be drawn.
 *
 * Spelled out rather than read from `HTMLMediaElement`, whose readyState
 * constants are absent from some non-browser DOM implementations, where the
 * comparison would silently become `x < undefined` and the guard would never
 * fire.
 */
const HAVE_CURRENT_DATA = 2;

/**
 * Rec. 601 luma weights.
 *
 * The same weights the iOS sampler applies to its BGRA pixel buffer. Any other
 * weighting would shift every score by a scene-dependent amount and detune the
 * gate on one platform while leaving the other correct, which is the kind of
 * difference that never shows up in a test and always shows up in the field.
 */
const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;

/**
 * Reduce an RGBA readback to one luma byte per cell, row-major.
 *
 * `out` sets the length, and `rgba` must hold four bytes for each of its cells.
 * Writing in place is what lets a tick reuse one scratch grid instead of
 * allocating a new one per frame. Alpha is ignored: a video frame is opaque.
 */
export function lumaGridFromRgba(
  rgba: Uint8ClampedArray,
  out: Uint8Array,
): void {
  for (let cell = 0; cell < out.length; cell++) {
    const offset = cell * 4;
    out[cell] = Math.round(
      LUMA_RED * rgba[offset]! +
        LUMA_GREEN * rgba[offset + 1]! +
        LUMA_BLUE * rgba[offset + 2]!,
    );
  }
}

export interface FrameSampler {
  /**
   * Begin sampling `video`. Starting an already-started sampler retargets it:
   * the previous loop is cancelled first, so exactly one loop is ever live.
   */
  start(video: HTMLVideoElement): void;
  /** Cancel the pending callback and detach the listeners. Idempotent. */
  stop(): void;
}

export interface FrameSamplerOptions {
  readonly gate: FrameGate;
  /** Called for every frame the gate judges, kept or skipped. */
  readonly onDecision: (decision: FrameGateDecision, nowMs: number) => void;
  /**
   * Sample one callback in every `frameStride`, defaulting to all of them.
   *
   * The gate's own rate floor bounds what is kept, so this bounds what is
   * looked at: the escape hatch for a device where a per-frame draw and readback
   * costs more than the decision is worth. Values below 1 are clamped.
   */
  readonly frameStride?: number;
}

/** The two canvases a tick draws through, kept for the life of the sampler. */
interface SamplingSurface {
  readonly intermediateCanvas: HTMLCanvasElement;
  readonly intermediateContext: CanvasRenderingContext2D;
  readonly gridContext: CanvasRenderingContext2D;
}

/** How a sampler asks to be woken for the next frame. */
interface FrameLoop {
  /**
   * True when the browser delivers one callback per presented video frame,
   * false when the loop is riding the animation frame instead.
   */
  readonly perVideoFrame: boolean;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

function frameLoopFor(video: HTMLVideoElement): FrameLoop {
  if (
    typeof video.requestVideoFrameCallback === "function" &&
    typeof video.cancelVideoFrameCallback === "function"
  ) {
    return {
      perVideoFrame: true,
      request: (callback) => video.requestVideoFrameCallback(() => callback()),
      cancel: (handle) => video.cancelVideoFrameCallback(handle),
    };
  }
  return {
    perVideoFrame: false,
    request: (callback) => requestAnimationFrame(() => callback()),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * Create a sampler.
 *
 * Nothing is allocated or touched until {@link FrameSampler.start}, apart from
 * the scratch grid, so a sampler can be built during render and started from an
 * effect.
 */
export function createFrameSampler(options: FrameSamplerOptions): FrameSampler {
  const { gate, onDecision } = options;
  const stride = Math.max(1, Math.floor(options.frameStride ?? 1));

  // One buffer for every frame this sampler will ever take. The gate reads a
  // grid synchronously and never retains it, so there is nothing to copy.
  const scratchGrid = new Uint8Array(FRAME_GRID_CELLS);

  let surface: SamplingSurface | null = null;
  let surfaceResolved = false;

  let video: HTMLVideoElement | null = null;
  let loop: FrameLoop | null = null;
  let pendingHandle: number | null = null;
  let frameIndex = 0;
  // Playback position of the last frame sampled, read only by the
  // animation-frame fallback. NaN compares equal to nothing, so the first tick
  // after a start always samples.
  let lastSampledTime = Number.NaN;

  /**
   * Build the canvases on first use and keep them, or record that a 2D context
   * is unavailable so the attempt is made once rather than on every frame.
   */
  function ensureSurface(): SamplingSurface | null {
    if (surfaceResolved) {
      return surface;
    }
    surfaceResolved = true;

    const intermediateCanvas = document.createElement("canvas");
    intermediateCanvas.width = INTERMEDIATE_SIZE;
    intermediateCanvas.height = INTERMEDIATE_SIZE;
    const gridCanvas = document.createElement("canvas");
    gridCanvas.width = FRAME_GRID_SIZE;
    gridCanvas.height = FRAME_GRID_SIZE;

    const intermediateContext = intermediateCanvas.getContext("2d");
    // The grid canvas is read back on every sampled frame, which is the case
    // `willReadFrequently` exists for: it asks for a software-backed surface
    // and avoids a GPU readback stall per tick.
    const gridContext = gridCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!intermediateContext || !gridContext) {
      return null;
    }

    // Both steps must average rather than point sample. See the module header:
    // this is the setting the whole two-canvas chain exists to keep in effect.
    intermediateContext.imageSmoothingEnabled = true;
    intermediateContext.imageSmoothingQuality = "high";
    gridContext.imageSmoothingEnabled = true;
    gridContext.imageSmoothingQuality = "high";

    surface = { intermediateCanvas, intermediateContext, gridContext };
    return surface;
  }

  function readGridPixels(source: HTMLVideoElement): Uint8ClampedArray | null {
    const canvases = ensureSurface();
    if (!canvases) {
      return null;
    }
    canvases.intermediateContext.drawImage(
      source,
      0,
      0,
      INTERMEDIATE_SIZE,
      INTERMEDIATE_SIZE,
    );
    canvases.gridContext.drawImage(
      canvases.intermediateCanvas,
      0,
      0,
      FRAME_GRID_SIZE,
      FRAME_GRID_SIZE,
    );
    // The one allocation a tick cannot avoid: `getImageData` hands back a fresh
    // buffer every call and the canvas API offers no way to read into one.
    return canvases.gridContext.getImageData(
      0,
      0,
      FRAME_GRID_SIZE,
      FRAME_GRID_SIZE,
    ).data;
  }

  function sampleFrame(): void {
    const source = video;
    if (!source || !loop) {
      return;
    }
    if (source.readyState < HAVE_CURRENT_DATA) {
      return;
    }
    // Both of these cover the same hazard, which only the animation frame has:
    // it fires on the display's schedule rather than the camera's, so it can
    // read one picture more than once. `requestVideoFrameCallback` runs once
    // per presented frame and cannot reach either state.
    if (!loop.perVideoFrame) {
      // A stopped stream holds its last picture indefinitely. Sampling it
      // repeatedly is a perfectly settled scene that earns a heartbeat keep.
      if (source.paused || source.ended) {
        return;
      }
      // The same thing at video rate: a 24 fps stream on a 60 Hz display holds
      // each frame across two or three animation frames, and a repeat sample
      // scores zero motion against its own twin. That reads as a settled camera
      // on alternate ticks, and the settle check then waves through a smeared
      // frame mid-pan, which is the case it exists to catch. An advancing
      // `currentTime` is what separates a new frame from the same one again.
      if (source.currentTime === lastSampledTime) {
        return;
      }
    }

    const pixels = readGridPixels(source);
    if (!pixels) {
      return;
    }
    lastSampledTime = source.currentTime;
    lumaGridFromRgba(pixels, scratchGrid);

    const nowMs = performance.now();
    onDecision(gate.offer(scratchGrid, nowMs), nowMs);
  }

  function tick(): void {
    pendingHandle = null;
    if (frameIndex % stride === 0) {
      sampleFrame();
    }
    frameIndex += 1;
    schedule();
  }

  function schedule(): void {
    if (!video || !loop || pendingHandle !== null) {
      return;
    }
    // A hidden tab throttles or suspends both loops anyway, and a camera whose
    // frames nobody can see is not worth a decision. Scheduling resumes from
    // the visibility listener.
    if (document.visibilityState === "hidden") {
      return;
    }
    pendingHandle = loop.request(tick);
  }

  function cancelPending(): void {
    if (loop && pendingHandle !== null) {
      loop.cancel(pendingHandle);
    }
    pendingHandle = null;
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      cancelPending();
      return;
    }
    schedule();
  }

  function stop(): void {
    cancelPending();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    video = null;
    loop = null;
  }

  function start(next: HTMLVideoElement): void {
    stop();
    video = next;
    loop = frameLoopFor(next);
    frameIndex = 0;
    lastSampledTime = Number.NaN;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule();
  }

  return { start, stop };
}
