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
 * The gap is measured between the two CAPTURES, and the primer decodes while
 * the second capture is already in flight, so what separates the two stamps is
 * the spacing plus one bridge call. Decode latency is out of it entirely,
 * and a pair whose captures land further apart than the window is discarded
 * rather than offered. That case is a slow bridge, and it is precisely the
 * hardware the blur check matters most on: offering the frame anyway would
 * hand the gate a motion of null, skip the settle check, and let a mid-pan
 * frame through on novelty alone. So a device too slow to produce a comparable
 * pair keeps nothing at all.
 *
 * Its signature on a handset is a Live session that runs and never pulses: no
 * held frame, no rows in the transcript, and a tuning readout whose decision
 * count stops advancing while the camera is plainly open. Each discarded pair
 * also logs the gap it measured against the window, which is the number to
 * report. See `docs/CAMERA_MODE_QA.md`.
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
 * - It does not issue bridge calls concurrently, and neither does any other
 *   instance of it: the plugin holds one capture callback, so every sample
 *   queues behind the last (see `captureSlot`). A bridge that answers slowly
 *   therefore slows the poll rather than corrupting it, and the pair's own
 *   bound turns the added delay into a discard rather than a false accept.
 *   Only a call that was ISSUED can hold the queue: a sample whose run ends
 *   while it is still waiting leaves without touching the bridge. An issued
 *   call that is never answered, which is what a camera closed or suspended
 *   underneath a request looks like, holds the queue until
 *   {@link NATIVE_CAPTURE_SLOT_RELEASE_MS} and is then let go: the poll is
 *   quiet for at most that long and resumes on its own, and a Live started
 *   again after the camera comes back samples normally. Nothing usable is
 *   given up, because a call answering that late would blow the pair's gap
 *   bound and be discarded anyway.
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
 * Half the gate's motion window rather than all of it. What the gate measures
 * is the time between the two CAPTURES, which is this delay plus the second
 * bridge call, so half leaves that call room to vary before the pair falls
 * outside the window and is discarded.
 *
 * Derived from {@link FrameGateOptions.motionMaxAgeMs} rather than written
 * beside it, so retuning the gate cannot leave the pairing quietly useless.
 */
export const NATIVE_PAIR_SPACING_MS = Math.round(
  DEFAULT_FRAME_GATE_OPTIONS.motionMaxAgeMs / 2,
);

/**
 * Widest capture-to-capture gap a pair may have and still be offered.
 *
 * The gate's own motion window, read from the shipped options rather than the
 * live record: `motionMaxAgeMs` is not one of the thresholds a slider can move
 * (see `FRAME_GATE_OVERRIDE_KEYS`), so the two are the same number and the
 * source can know it without holding the gate's configuration.
 */
export const NATIVE_PAIR_MAX_GAP_MS = DEFAULT_FRAME_GATE_OPTIONS.motionMaxAgeMs;

/**
 * How long an issued bridge call may hold the queue before it is abandoned.
 *
 * Ten seconds is chosen to be unreachable by any call that is still going to
 * answer: two orders of magnitude past a healthy round trip, ten poll
 * intervals, and roughly eighty times the motion window, so a call still
 * outstanding here could not produce a frame the pair's bound would accept even
 * if it landed. Nothing usable is given up by letting go of it.
 *
 * The danger the queue exists to prevent is a second call racing a LIVE one.
 * A call outstanding this long is not live: the camera behind it has been
 * closed or suspended, and the platforms agree that whoever asks next owns the
 * answer. On iOS `CameraController.captureSample` stores a single
 * `sampleBufferCaptureCompletionBlock`, which a later call replaces and the
 * sample-buffer delegate then fires for that later call before clearing it. On
 * Android `CameraPreview.captureSample` saves the call and overwrites
 * `snapshotCallbackId`, and `onSnapshotTaken` resolves whatever that id names.
 * Either way the overwrite strands only the abandoned promise, which by then
 * nobody is waiting on, and the frame the new call receives is the frame taken
 * for the new call.
 */
export const NATIVE_CAPTURE_SLOT_RELEASE_MS = 10_000;

/** A sample off the bridge, stamped with a bound on when its picture was taken. */
interface CapturedSample {
  readonly encoded: string;
  /**
   * A bound on when this picture was taken, and what the gate is stamped with.
   *
   * The bridge says when it answered, never when the sensor fired, so all that
   * is known is that the picture was taken somewhere between the request and
   * the answer. The two samples of a pair therefore take opposite ends: see
   * {@link CaptureBound}.
   *
   * Never the decode's time. A pair is compared across the interval between two
   * PICTURES, and a decode that ran between them would count against a window
   * it has nothing to do with.
   */
  readonly capturedAtMs: number;
  /**
   * When the bridge was asked, which is the earliest the picture can have been
   * taken whatever bound `capturedAtMs` records. The gate's forced-keep arm is
   * compared against this: a request issued before the ask cannot prove its
   * picture postdates it, however late the answer lands.
   */
  readonly requestedAtMs: number;
}

/**
 * Which end of a capture's own window to record.
 *
 * A capture spans a request and an answer with the picture somewhere inside,
 * so a pair's measured gap is only trustworthy if it cannot understate the true
 * separation. The primer records the EARLIEST moment its picture could have
 * been taken and the judged frame the LATEST, which makes their difference an
 * upper bound: a pair measuring inside the gate's motion window is certainly
 * inside it, and every error the bound makes discards a usable pair rather than
 * accepting an unusable one.
 *
 * Stamping both at the answer would understate it. A primer whose bridge call
 * ran longer than the judged frame's reports a gap shorter than the pictures
 * really were apart, and the gate then measures motion across an interval it
 * would have refused.
 */
type CaptureBound = "earliest" | "latest";

/** That sample decoded and reduced, ready for the gate. */
interface DecodedSample {
  readonly grid: FrameGrid;
  readonly blob: Blob;
}

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
   * Take one pair now, without waiting for the next tick.
   *
   * For the moment the owner knows a frame matters more than the cadence says
   * it does, which the poll cannot see: at a sample a second the frame that
   * answers a question asked now can be most of a second old. Nothing else
   * about the pair changes, so what reaches the gate is a properly primed
   * frame rather than a lone capture with no motion baseline.
   *
   * While a pair for this run is already out, the ask is remembered rather
   * than raced: that pair's captures predate the ask, so the gate will not
   * spend an arm on them, and a second pair beside it would queue on the
   * bridge and blow its own gap bound. One follow-up pair is taken when the
   * outstanding one settles. The memory dies with the run, so a flip or a stop
   * drops it. Ignored on a source that is not polling: a stopped source
   * samples nothing, however it is asked.
   */
  sampleNow(): void;
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
 * The one bridge call allowed to be outstanding, process-wide.
 *
 * `@capacitor-community/camera-preview` is not reentrant on either platform:
 * Android keeps a single snapshot callback id and iOS a single sample-buffer
 * completion block, so a second `captureSample` issued beside a first
 * overwrites the slot the first is waiting on. The older request then never
 * answers, or answers with the newer request's picture, and a frame of one
 * moment is judged as another.
 *
 * Nothing about a run boundary makes that safe: an invalidate leaves the call
 * it abandoned still running on the bridge, and a source swapped out by the
 * room leaves one behind too. So the queue is module scope rather than per
 * source or per generation, which is the only scope the plugin's own single
 * slot actually has.
 *
 * Generations decide both whether a queued call is still worth issuing when
 * the slot reaches it and what its result is worth once it answers. The queue
 * decides only the order.
 */
let captureSlot: Promise<void> = Promise.resolve();

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
  /**
   * Whether a `sampleNow` arrived while this run's pair was already out.
   *
   * The pair in flight captured its frames before the ask, so it cannot be the
   * answer: the gate refuses to spend an arm on a capture stamped before it.
   * The ask is remembered instead, and the tick that holds the claim issues one
   * follow-up pair when it settles. Cleared with the run it was made in: a
   * flip or a stop makes it an ask about a camera that is gone.
   */
  let immediateWanted = false;

  /**
   * Issue one bridge call once the slot is free, and report when it was
   * actually issued.
   *
   * The request time is read inside the queued work, not at the moment this is
   * called. A call waiting behind an earlier one has not been made yet, and
   * stamping it on arrival would date its picture to before the camera was
   * asked for it, which would inflate the pair's gap and discard a pair that
   * was really taken back to back.
   */
  /**
   * Resolve with the call's answer, or with nothing once the deadline passes.
   *
   * A late answer is dropped rather than delivered: it has been given up on,
   * and the tick that wanted it is long gone. A late REJECTION is dropped the
   * same way, which is what keeps it from surfacing as an unhandled one.
   */
  function withReleaseDeadline(
    call: Promise<string | null>,
  ): Promise<{ answered: boolean; encoded: string | null }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        console.debug(
          "[native-frame-source] capture abandoned, releasing the bridge:",
          { afterMs: NATIVE_CAPTURE_SLOT_RELEASE_MS },
        );
        resolve({ answered: false, encoded: null });
      }, NATIVE_CAPTURE_SLOT_RELEASE_MS);
      call.then(
        (encoded) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve({ answered: true, encoded });
        },
        (err: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          reject(err);
        },
      );
    });
  }

  function issueCapture(run: number): Promise<{
    encoded: string | null;
    requestedAtMs: number;
  } | null> {
    const issued = captureSlot.then(async () => {
      // Read when the slot opens, not only when the call returns. A run that
      // ended while this waited belongs to a camera that may be closed, and a
      // request into a closed camera can wait forever on a queue that has no
      // timeout, stranding every sample behind it for the life of the tab.
      // Leaving without touching the bridge costs nothing and frees the slot.
      if (generation !== run) {
        return null;
      }
      const requestedAtMs = now();
      const { answered, encoded } = await withReleaseDeadline(captureSample());
      // Abandoned. The queue moves on, this tick produces nothing, and the
      // next one asks a camera that may since have come back.
      return answered ? { encoded, requestedAtMs } : null;
    });
    // The queue survives whatever this call does, so one refusal cannot wedge
    // every later sample behind it.
    captureSlot = issued.then(
      () => undefined,
      () => undefined,
    );
    return issued;
  }

  /** Ask the bridge for one sample and bound when its picture was taken. */
  async function captureStamped(
    run: number,
    bound: CaptureBound,
  ): Promise<CapturedSample | null> {
    const issued = await issueCapture(run);
    if (!issued) {
      return null;
    }
    const { encoded, requestedAtMs } = issued;
    const capturedAtMs = bound === "earliest" ? requestedAtMs : now();
    // A stop, a flip, or a camera mid-teardown answers with nothing. That is
    // the ordinary shape of this call and not a reason to end the poll.
    if (!encoded || generation !== run) {
      return null;
    }
    return { encoded, capturedAtMs, requestedAtMs };
  }

  /** Decode one sample and reduce it through the shared chain. */
  async function decodeSample(
    sample: CapturedSample,
    run: number,
  ): Promise<DecodedSample | null> {
    // The bridge answers with bare base64, and the shared decoder also takes
    // the data URI a plugin might send instead.
    const bytes = decodeBase64Payload(sample.encoded);
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

  /**
   * Wait until `targetMs`, on the timer the cadence already runs on.
   *
   * The pair's spacing is measured from the primer's own stamp, which is when
   * it was REQUESTED. So the spacing budget covers the primer's bridge call
   * too: a call that outruns it leaves no wait at all and the second sample is
   * asked for at once. That is the right way round. The budget exists to keep
   * the two pictures inside the gate's window, and a slow primer has already
   * spent it, so adding a further delay would only push a pair that is already
   * marginal past the limit and turn an offer into a discard.
   */
  function waitUntil(targetMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, targetMs - now()));
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
      const first = await captureStamped(run, "earliest");
      if (!first || generation !== run) {
        return;
      }

      // The second capture is scheduled off the FIRST capture's stamp and is
      // fired without waiting for the first to decode, so decoding the primer
      // runs alongside it instead of inside the gap. What is left between the
      // two stamps is the spacing and one bridge call.
      const secondPromise = waitUntil(
        first.capturedAtMs + NATIVE_PAIR_SPACING_MS,
      ).then(
        // A run that ended while the spacing elapsed does not spend a bridge
        // call on a frame nobody can use.
        () => (generation === run ? captureStamped(run, "latest") : null),
        // A bridge that refuses the second call costs this tick and no more.
        () => null,
      );

      const primer = await decodeSample(first, run);
      if (primer) {
        // Read synchronously by the gate, so the producer's one reused grid is
        // free again before the second sample is drawn through it.
        gate.observe(primer.grid, first.capturedAtMs);
      }

      // Awaited on every path, so a refusal cannot outlive this tick unhandled.
      const second = await secondPromise;
      // No fallback to the primer. Offering it would be a frame with no motion
      // baseline of its own, which is the blind keep the pair exists to stop.
      if (!primer || !second || generation !== run) {
        return;
      }

      // The invariant, enforced rather than hoped for. Past the window the gate
      // reports no motion, the settle check does not run, and the frame becomes
      // keepable on novelty alone: a blurred mid-pan view, uploaded and
      // persisted as what the call is being shown. A device too slow to produce
      // a comparable pair must therefore produce no keeps at all, which is a
      // feature that visibly does nothing rather than one that quietly sends
      // the wrong picture.
      const gapMs = second.capturedAtMs - first.capturedAtMs;
      if (gapMs > NATIVE_PAIR_MAX_GAP_MS) {
        console.debug(
          "[native-frame-source] pair outside the motion window, skipped:",
          { gapMs, limitMs: NATIVE_PAIR_MAX_GAP_MS },
        );
        return;
      }

      const judged = await decodeSample(second, run);
      if (!judged || generation !== run) {
        return;
      }
      onDecision(
        // The request time rides along as the capture's lower bound: the
        // answer-time stamp can postdate a forced-keep arm that the picture
        // itself predates, and the arm must not be spent on it.
        gate.offer(judged.grid, second.capturedAtMs, second.requestedAtMs),
        second.capturedAtMs,
        judged.blob,
      );
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
        // An ask that arrived mid-pair gets its answer here: one follow-up
        // pair, whose captures postdate the ask, on the run that heard it.
        if (immediateWanted && generation === run) {
          immediateWanted = false;
          void sampleOnce();
        }
      }
    }
  }

  function invalidate(): void {
    generation += 1;
    immediateWanted = false;
  }

  function sampleNow(): void {
    // The cadence's own claim, `samplingGeneration`, is what keeps this from
    // running beside a tick.
    if (timer === null) {
      return;
    }
    // The pair already out captured before this ask, so it cannot answer it.
    // Remember the ask and let that pair's tick issue the follow-up.
    if (samplingGeneration === generation) {
      immediateWanted = true;
      return;
    }
    void sampleOnce();
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

  return { start, sampleNow, invalidate, stop };
}
