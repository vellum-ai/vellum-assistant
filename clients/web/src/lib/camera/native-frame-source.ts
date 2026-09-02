/**
 * The native half of live vision: turns a native camera preview into the same
 * luma grids the frame gate decides on.
 *
 * A Capacitor shell renders its preview behind the web view, so there is no
 * `<video>` to draw and no per-frame callback to ride. What there is is a
 * sample call on the bridge, which both mobile implementations serve from the
 * buffer the preview is already producing. So this source polls: one sample per
 * interval, decoded and drawn through {@link createFrameGridProducer}, the same
 * two-step area average the browser sampler uses. Sharing that chain is what
 * lets one set of gate thresholds serve both platforms.
 *
 * ## Why a poll rather than a stream
 *
 * Every sample costs a bridge round trip, a JPEG encode on the native side and
 * a decode on this one. At video rate that is not affordable, and it is not
 * needed either: the gate's own rate floor means most frames it looks at are
 * discarded anyway. A cadence near a second keeps the cost proportional to what
 * a keep is worth, and a single explicit hold is what turns it on.
 *
 * ## What this module does not do
 *
 * - It does not open, stop, or flip the camera, and does not know which one is
 *   running. It is handed a capture function and forgets it on {@link
 *   NativeFrameSource.stop}.
 * - It does not call {@link FrameGate.reset}. A flip invalidates the gate's
 *   history, and only the owner of the camera knows one happened.
 * - It does not upload. It hands the offered JPEG back with the decision and
 *   the owner decides what a keep is worth.
 */

import type { FrameGate, FrameGateDecision } from "./frame-gate";
import { createFrameGridProducer, type FrameSource } from "./frame-sampler";

/**
 * Default gap between samples.
 *
 * Below the gate's own rate floor, so the gate and not this cadence decides how
 * often a frame is kept, and far enough above a bridge round trip that a sample
 * finishes long before the next tick asks for one.
 */
export const NATIVE_FRAME_SAMPLE_INTERVAL_MS = 1000;

/** A decoded sample, plus whatever holding it costs. */
export interface DecodedFrame {
  readonly image: FrameSource;
  /** Free the decode's resources. Called once, whatever the grid step does. */
  release(): void;
}

/** Turns sampled JPEG bytes into something the downscale chain can draw. */
export type FrameDecoder = (blob: Blob) => Promise<DecodedFrame | null>;

export interface NativeFrameSourceOptions {
  readonly gate: FrameGate;
  /**
   * Resolves a base64 JPEG of the current preview, or null when the camera
   * cannot serve one. Must not reject.
   */
  readonly captureSample: () => Promise<string | null>;
  /**
   * Called for every frame the gate judges, kept or skipped. `sample` is the
   * exact JPEG the decision was made on, so a keep can be persisted without
   * capturing a second, different frame.
   */
  readonly onDecision: (
    decision: FrameGateDecision,
    nowMs: number,
    sample: Blob,
  ) => void;
  /** Gap between samples, defaulting to {@link NATIVE_FRAME_SAMPLE_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** Decode step, defaulting to the platform image decoder. */
  readonly decode?: FrameDecoder;
}

export interface NativeFrameSource {
  /** Begin polling. Starting an already-started source restarts its cadence. */
  start(): void;
  /** Stop polling and detach the listeners. Idempotent. */
  stop(): void;
}

/** Decode JPEG bytes through the platform decoder. */
async function decodeWithImageBitmap(blob: Blob): Promise<DecodedFrame | null> {
  const bitmap = await createImageBitmap(blob);
  return { image: bitmap, release: () => bitmap.close() };
}

/**
 * Wrap the bridge's base64 in a Blob.
 *
 * The bridge answers with bare base64, but tolerating a data URI costs one
 * branch and covers a plugin that decides to send one.
 */
function jpegBlobFromBase64(encoded: string): Blob | null {
  const base64 = encoded.startsWith("data:")
    ? (encoded.match(/;base64,(.*)$/)?.[1] ?? "")
    : encoded;
  if (!base64) {
    return null;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

/**
 * Create a native frame source.
 *
 * Nothing is polled until {@link NativeFrameSource.start}, so a source can be
 * built during render and started from an effect.
 */
export function createNativeFrameSource(
  options: NativeFrameSourceOptions,
): NativeFrameSource {
  const { gate, captureSample, onDecision } = options;
  const intervalMs = Math.max(
    1,
    Math.floor(options.intervalMs ?? NATIVE_FRAME_SAMPLE_INTERVAL_MS),
  );
  const decode = options.decode ?? decodeWithImageBitmap;
  const grids = createFrameGridProducer();

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // A sample outlives the tick that asked for it: a bridge round trip plus a
  // decode can outrun the cadence on a busy device. Two in flight would queue
  // on the bridge and hand the gate frames out of order, so a tick that finds
  // one already running is dropped rather than deferred.
  let sampling = false;

  async function sampleOnce(): Promise<void> {
    if (sampling) {
      return;
    }
    sampling = true;
    try {
      const encoded = await captureSample();
      // A stop, a flip, or a camera mid-teardown answers with nothing. That is
      // the ordinary shape of this call and not a reason to end the poll.
      if (!encoded || !running) {
        return;
      }
      const blob = jpegBlobFromBase64(encoded);
      if (!blob) {
        return;
      }
      const frame = await decode(blob);
      if (!frame) {
        return;
      }
      try {
        if (!running) {
          return;
        }
        const grid = grids.gridFrom(frame.image);
        if (!grid) {
          return;
        }
        const nowMs = performance.now();
        onDecision(gate.offer(grid, nowMs), nowMs, blob);
      } finally {
        frame.release();
      }
    } catch (err) {
      // A camera that stops answering is the common case, and the next tick is
      // its retry. Nothing a single sample can do is worth ending the poll.
      console.debug("[native-frame-source] sample failed:", err);
    } finally {
      sampling = false;
    }
  }

  function schedule(): void {
    if (!running || timer !== null) {
      return;
    }
    // A hidden shell has released the camera, and a frame nobody can see is not
    // worth a decision. Polling resumes from the visibility listener.
    if (document.visibilityState === "hidden") {
      return;
    }
    timer = setInterval(() => {
      void sampleOnce();
    }, intervalMs);
  }

  function cancelPending(): void {
    if (timer !== null) {
      clearInterval(timer);
    }
    timer = null;
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      cancelPending();
      return;
    }
    schedule();
  }

  function stop(): void {
    running = false;
    cancelPending();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }

  function start(): void {
    stop();
    running = true;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule();
  }

  return { start, stop };
}
