/**
 * The native half of live vision: turns a native camera preview into the same
 * luma grids the frame gate decides on.
 *
 * A Capacitor shell renders its preview behind the web view, so there is no
 * `<video>` to draw and no per-frame callback to ride. What there is is a
 * sample call on the bridge, which both mobile implementations serve from the
 * buffer the preview is already producing. So this source polls, decoding each
 * sample and drawing it through {@link createFrameGridProducer}, the same
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
 * ## Why each tick takes two samples
 *
 * The gate answers two different questions, and they need different spacing.
 * Novelty asks "is this worth sending", and a second between frames is fine for
 * it. Motion asks "is the camera steady right now", which on a handheld phone
 * is also the blur check, and it is only meaningful across a short gap: past
 * {@link FrameGateOptions.motionMaxAgeMs} the gate reports no motion at all,
 * because a small difference across a whole second means the scene is static,
 * not that the hand is. A poll offering one frame per second therefore never
 * produces a motion number, the settle check never runs, and the first frame
 * past the rate floor is kept however hard the camera is being panned.
 *
 * So a tick takes a PAIR, {@link NATIVE_PAIR_SPACING_MS} apart. The first is
 * handed to `FrameGate.observe`, which makes it the motion baseline and nothing
 * else, and the second is the one offered. Its motion is measured across the
 * pair rather than across the poll, so the same settle threshold means the same
 * thing here as it does at video rate.
 *
 * The cost is two bridge round trips a second instead of one, for as long as
 * the user holds Live. That is the price of the blur check, and it is bounded
 * by the same hold: nothing samples while the shutter is idle.
 *
 * A pair whose two frames land further apart than the motion window (a slow
 * device, a slow bridge) simply reports no motion, which is the behavior of a
 * poll with no pairing at all. The readout shows motion as absent when that
 * happens, so it is visible on a device rather than silent.
 *
 * ## What this module does not do
 *
 * - It does not open, stop, or flip the camera, and does not know which one is
 *   running. It is handed a capture function and forgets it on {@link
 *   NativeFrameSource.stop}.
 * - It does not call {@link FrameGate.reset}. A flip invalidates the gate's
 *   history, and only the owner of the camera knows one happened. The owner
 *   says so with {@link NativeFrameSource.invalidate}, which is also what
 *   refuses the sample such a change caught in flight: the bytes were taken of
 *   the world before it, and nothing downstream can tell them apart from bytes
 *   taken after.
 * - It does not upload. It hands the offered JPEG back with the decision and
 *   the owner decides what a keep is worth.
 * - It does not watch the app's lifecycle. Backgrounding is the owner's to
 *   answer, through the deduped `app.hidden` bus edge that also covers the
 *   Capacitor shells (see `docs/EVENT_BUS.md`), and the owner answers it by
 *   stopping this source. A `visibilitychange` listener here would be a second
 *   opinion about the same edge, blind to the one the shells report without a
 *   DOM event.
 */

import { decodeBase64Payload } from "@/utils/base64";

import {
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGate,
  type FrameGateDecision,
  type FrameGrid,
} from "./frame-gate";
import { createFrameGridProducer, type FrameSource } from "./frame-sampler";

/**
 * Default gap between ticks, each of which takes a pair.
 *
 * Below the gate's own rate floor, so the gate and not this cadence decides how
 * often a frame is kept, and far enough above a pair (two bridge round trips
 * and the spacing between them) that a tick finishes long before the next one
 * asks for another.
 */
export const NATIVE_FRAME_SAMPLE_INTERVAL_MS = 1000;

/**
 * Gap between the two samples of one tick.
 *
 * Half the gate's motion window rather than all of it, because what the gate
 * measures is the time between the two frames LANDING, which carries the second
 * capture's own bridge and decode latency on top of this delay. Half leaves
 * that latency room to vary without pushing the pair outside the window, where
 * motion would silently stop being reported.
 *
 * Derived from {@link FrameGateOptions.motionMaxAgeMs} rather than written
 * beside it, so retuning the gate cannot leave the pairing quietly useless.
 */
export const NATIVE_PAIR_SPACING_MS = Math.round(
  DEFAULT_FRAME_GATE_OPTIONS.motionMaxAgeMs / 2,
);

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
  /**
   * Monotonic clock the gate is stamped from, defaulting to `performance.now`.
   *
   * The gate deliberately reads no clock of its own, so that what it decides
   * can be tested without faking time. This is the same seam one level up: the
   * pair's spacing and the poll's cadence are both intervals the gate reasons
   * about, and neither is observable through a real clock in a test.
   */
  readonly now?: () => number;
}

export interface NativeFrameSource {
  /** Begin polling. Starting an already-started source restarts its cadence. */
  start(): void;
  /**
   * Refuse whatever is in flight, and keep polling.
   *
   * For the boundaries only the owner can see: the camera flipping, a transport
   * reconnect. The sample crossing the bridge was taken of the world before the
   * change, and by the time it is offered the change has happened, so every
   * guard downstream reads it as current. Stopping and starting would refuse it
   * too, at the cost of a whole interval of blindness for a poll that has
   * nothing to recover from.
   */
  invalidate(): void;
  /** Stop polling. Idempotent. */
  stop(): void;
}

/** Decode JPEG bytes through the platform decoder. */
async function decodeWithImageBitmap(blob: Blob): Promise<DecodedFrame | null> {
  const bitmap = await createImageBitmap(blob);
  return { image: bitmap, release: () => bitmap.close() };
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
  const now = options.now ?? (() => performance.now());
  const grids = createFrameGridProducer();

  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Which run of this source is current. Bumped by every invalidate, and so by
   * every stop and every start.
   *
   * A capture and a decode are both awaits, and the world can change inside
   * either one: the run can end, or the camera behind it can be replaced.
   * Without a number to compare against, a sample of the scene that is gone
   * lands looking exactly like a fresh one, and the gate scores against a view
   * the user has already turned away from.
   */
  let generation = 0;
  /**
   * The run whose sample is on the bridge right now, or null when none is.
   *
   * A sample outlives the tick that asked for it: a round trip plus a decode
   * can outrun the cadence on a busy device. Two in flight would queue on the
   * bridge, so a tick that finds its own run already sampling is dropped rather
   * than deferred. Held per run, not as a flag, so a sample stranded by a
   * restart or an invalidate cannot suppress the new run's ticks until it
   * settles. Crossing a run boundary is therefore the one case where two
   * samples can be out at once, which is the price of not going blind for an
   * interval over a frame nobody wants.
   */
  let samplingGeneration: number | null = null;

  /** One sample, taken through the shared chain, or null if it produced none. */
  async function takeSample(
    run: number,
  ): Promise<{ grid: FrameGrid; blob: Blob } | null> {
    const encoded = await captureSample();
    // A stop, a flip, or a camera mid-teardown answers with nothing. That is
    // the ordinary shape of this call and not a reason to end the poll.
    if (!encoded || generation !== run) {
      return null;
    }
    // The bridge answers with bare base64, and the shared decoder also takes
    // the data URI a plugin might send instead.
    const bytes = decodeBase64Payload(encoded);
    if (!bytes) {
      return null;
    }
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const frame = await decode(blob);
    if (!frame) {
      return null;
    }
    try {
      if (generation !== run) {
        return null;
      }
      const grid = grids.gridFrom(frame.image);
      return grid ? { grid, blob } : null;
    } finally {
      frame.release();
    }
  }

  /** Wait out the pair's spacing, on the timer the cadence already runs on. */
  function waitPairSpacing(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, NATIVE_PAIR_SPACING_MS);
    });
  }

  async function sampleOnce(): Promise<void> {
    const run = generation;
    if (samplingGeneration === run) {
      return;
    }
    samplingGeneration = run;
    try {
      // The primer. Its bytes are never offered and never uploaded: it exists
      // so the frame that IS offered has something recent to measure motion
      // against. Its grid is read synchronously by `observe`, so the buffer the
      // producer reuses for the second sample is free to overwrite it.
      const first = await takeSample(run);
      if (!first || generation !== run) {
        return;
      }
      gate.observe(first.grid, now());

      await waitPairSpacing();
      if (generation !== run) {
        return;
      }

      const second = await takeSample(run);
      // No fallback to the primer. Offering it would be a frame with no motion
      // baseline of its own, which is the blind keep the pair exists to stop.
      if (!second || generation !== run) {
        return;
      }
      const nowMs = now();
      onDecision(gate.offer(second.grid, nowMs), nowMs, second.blob);
    } catch (err) {
      // A camera that stops answering is the common case, and the next tick is
      // its retry. Nothing a single sample can do is worth ending the poll.
      console.debug("[native-frame-source] sample failed:", err);
    } finally {
      // Only this run's claim, and it spans the whole pair: a tick that lands
      // between the two samples must not start a second pair beside this one.
      // A newer run holds its own claim, and clearing that would let a second
      // sample onto the bridge next to it.
      if (samplingGeneration === run) {
        samplingGeneration = null;
      }
    }
  }

  function invalidate(): void {
    generation += 1;
  }

  function stop(): void {
    invalidate();
    if (timer !== null) {
      clearInterval(timer);
    }
    timer = null;
  }

  function start(): void {
    stop();
    timer = setInterval(() => {
      void sampleOnce();
    }, intervalMs);
  }

  return { start, invalidate, stop };
}
