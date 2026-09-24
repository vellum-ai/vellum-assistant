/**
 * Polls the native preview and feeds JPEGs through the shared frame-grid chain.
 * Each tick needs a nearby primer and judged frame so motion is measured within
 * the gate's window rather than across the one-second polling interval.
 *
 * Android shells supporting paired capture collect both preview buffers before
 * encoding and return monotonic offsets from their native request. Their gap
 * excludes encoding and bridge delivery. The JS request anchors these offsets
 * conservatively, and remains the lower bound for spending a forced-keep arm.
 *
 * Older shells and iOS return one JPEG per call. Those pairs use the first
 * request and second answer as an upper bound on frame separation; decoding the
 * primer overlaps the second capture. Both paths reject gaps outside the gate's
 * motion window and upload only the exact JPEG judged by the gate.
 *
 * A process-wide slot serializes bridge calls. Generation and owner-availability
 * checks discard captures crossing a stop, camera flip or reconnect. The owner
 * handles camera and app lifecycle; this source neither resets the gate nor
 * uploads frames.
 */

import { decodeBase64Payload } from "@/utils/base64";

import {
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGate,
  type FrameGateDecision,
  type FrameGrid,
} from "./frame-gate";
import { createFrameGridProducer, type FrameSource } from "./frame-sampler";
import {
  isNativeFramePair,
  type NativeFrameCapture,
} from "./native-frame-capture";

/** Default polling cadence. A tick skips while its run already has a pair out. */
export const NATIVE_FRAME_SAMPLE_INTERVAL_MS = 1000;

/**
 * Gap between the two samples of one tick.
 *
 * Half the motion window leaves room for the next native preview callback, or
 * for bridge overhead on shells that provide only single samples.
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
 * Native pairs have their own shorter deadline and request-owned callbacks.
 * Legacy shells can strand a callback when the camera stops; this bound frees
 * the shared slot so a reopened preview can resume sampling. Late answers and
 * rejections are discarded.
 */
export const NATIVE_CAPTURE_SLOT_RELEASE_MS = 10_000;

/** A sample off the bridge, stamped with a bound on when its picture was taken. */
interface CapturedSample {
  readonly encoded: string;
  /**
   * A bound on when this picture was taken, and what the gate is stamped with.
   *
   * Native pairs use preview callback offsets anchored at the JS request.
   * Legacy pairs bound the first capture at the request and the second at the
   * answer, so their difference cannot understate the capture separation.
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

/** Per-run sampling totals. Contains no images or raw bridge errors. */
export interface NativeFrameDiagnostics {
  readonly event: "started" | "sampling" | "stopped";
  readonly attempts: number;
  readonly captureRequests: number;
  readonly suppressedCaptures: number;
  readonly emptyCaptures: number;
  readonly captureTimeouts: number;
  readonly decodeFailures: number;
  readonly sampleErrors: number;
  readonly pairGapRejections: number;
  readonly decisions: number;
  readonly keeps: number;
  readonly lastCaptureMs: number | null;
  readonly maxCaptureMs: number;
  readonly lastPairGapMs: number | null;
  readonly maxPairGapMs: number;
  readonly pairGapLimitMs: number;
}

const DIAGNOSTICS_INTERVAL_MS = 30_000;

function emptyDiagnostics(): Omit<NativeFrameDiagnostics, "event"> {
  return {
    attempts: 0,
    captureRequests: 0,
    suppressedCaptures: 0,
    emptyCaptures: 0,
    captureTimeouts: 0,
    decodeFailures: 0,
    sampleErrors: 0,
    pairGapRejections: 0,
    decisions: 0,
    keeps: 0,
    lastCaptureMs: null,
    maxCaptureMs: 0,
    lastPairGapMs: null,
    maxPairGapMs: 0,
    pairGapLimitMs: NATIVE_PAIR_MAX_GAP_MS,
  };
}

export interface NativeFrameSourceOptions {
  readonly gate: FrameGate;
  /**
   * Resolves one JPEG or a native pair, or null when the camera cannot serve
   * one. Older shells return one JPEG per request.
   */
  readonly captureSample: () => Promise<NativeFrameCapture | null>;
  /** Owner availability, checked when the bridge slot opens and when it answers. */
  readonly canCapture?: () => boolean;
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
  /** Reports start, first attempt, periodic totals and stop, outside capture timing. */
  readonly onDiagnostics?: (diagnostics: NativeFrameDiagnostics) => void;
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
 * Legacy `captureSample` is not reentrant on either platform:
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

  let diagnostics = emptyDiagnostics();
  let lastDiagnosticsAtMs = -Infinity;

  function reportDiagnostics(event: NativeFrameDiagnostics["event"]): void {
    if (!options.onDiagnostics) {
      return;
    }
    const atMs = now();
    if (event === "sampling") {
      if (atMs - lastDiagnosticsAtMs < DIAGNOSTICS_INTERVAL_MS) {
        return;
      }
      lastDiagnosticsAtMs = atMs;
    }
    try {
      options.onDiagnostics({ ...diagnostics, event });
    } catch {
      // Diagnostic consumers cannot interrupt capture or teardown.
    }
  }

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
    call: Promise<NativeFrameCapture | null>,
  ): Promise<{ answered: boolean; encoded: NativeFrameCapture | null }> {
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
    encoded: NativeFrameCapture;
    requestedAtMs: number;
    answeredAtMs: number;
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
      if (options.canCapture?.() === false) {
        diagnostics = {
          ...diagnostics,
          suppressedCaptures: diagnostics.suppressedCaptures + 1,
        };
        return null;
      }
      const requestedAtMs = now();
      diagnostics = {
        ...diagnostics,
        captureRequests: diagnostics.captureRequests + 1,
      };
      const { answered, encoded } = await withReleaseDeadline(captureSample());
      const answeredAtMs = now();
      if (generation === run) {
        const durationMs = answeredAtMs - requestedAtMs;
        diagnostics = {
          ...diagnostics,
          lastCaptureMs: durationMs,
          maxCaptureMs: Math.max(diagnostics.maxCaptureMs, durationMs),
          captureTimeouts: diagnostics.captureTimeouts + Number(!answered),
          emptyCaptures:
            diagnostics.emptyCaptures + Number(answered && !encoded),
        };
      }
      // Abandoned. The queue moves on, this tick produces nothing, and the
      // next one asks a camera that may since have come back.
      if (
        !answered ||
        !encoded ||
        generation !== run ||
        options.canCapture?.() === false
      ) {
        return null;
      }
      return { encoded, requestedAtMs, answeredAtMs };
    });
    // The queue survives whatever this call does, so one refusal cannot wedge
    // every later sample behind it.
    captureSlot = issued.then(
      () => undefined,
      () => undefined,
    );
    return issued;
  }

  async function capturePair(run: number): Promise<{
    first: CapturedSample;
    second: Promise<CapturedSample | null>;
  } | null> {
    const issued = await issueCapture(run);
    if (!issued) {
      return null;
    }
    const { encoded, requestedAtMs, answeredAtMs } = issued;
    if (typeof encoded !== "string") {
      if (
        !isNativeFramePair(encoded) ||
        encoded.secondCapturedAfterMs > answeredAtMs - requestedAtMs
      ) {
        return null;
      }
      // Native offsets share a clock, so their difference excludes encoding
      // and bridge delivery. Anchoring at the JS request conservatively dates
      // both frames before their actual arrival on the native preview thread.
      return {
        first: {
          encoded: encoded.primer,
          capturedAtMs: requestedAtMs + encoded.firstCapturedAfterMs,
          requestedAtMs,
        },
        second: Promise.resolve({
          encoded: encoded.value,
          capturedAtMs: requestedAtMs + encoded.secondCapturedAfterMs,
          requestedAtMs,
        }),
      };
    }

    return {
      first: { encoded, capturedAtMs: requestedAtMs, requestedAtMs },
      second: waitUntil(requestedAtMs + NATIVE_PAIR_SPACING_MS).then(
        async () => {
          if (generation !== run) {
            return null;
          }
          const second = await issueCapture(run);
          if (!second || typeof second.encoded !== "string") {
            return null;
          }
          return {
            encoded: second.encoded,
            capturedAtMs: second.answeredAtMs,
            requestedAtMs: second.requestedAtMs,
          };
        },
      ),
    };
  }

  /** Decode one sample and reduce it through the shared chain. */
  async function decodeSample(
    sample: CapturedSample,
    run: number,
  ): Promise<DecodedSample | null> {
    const failed = (): null => {
      if (generation === run) {
        diagnostics = {
          ...diagnostics,
          decodeFailures: diagnostics.decodeFailures + 1,
        };
      }
      return null;
    };
    // The bridge answers with bare base64, and the shared decoder also takes
    // the data URI a plugin might send instead.
    const bytes = decodeBase64Payload(sample.encoded);
    if (!bytes) {
      return failed();
    }
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const frame = await decode(blob);
    if (!frame) {
      return failed();
    }
    try {
      if (generation !== run) {
        return null;
      }
      const grid = grids.gridFrom(frame.image);
      return grid ? { grid, blob } : failed();
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
    diagnostics = { ...diagnostics, attempts: diagnostics.attempts + 1 };
    try {
      // The primer. Its bytes are never offered and never uploaded: it exists
      // so the frame that IS offered has something recent to measure motion
      // against. Its grid is read synchronously by `observe`, so the buffer the
      // producer reuses for the second sample is free to overwrite it.
      const pair = await capturePair(run);
      if (!pair || generation !== run) {
        return;
      }
      const { first, second: secondPromise } = pair;
      // Observe rejections even if primer decoding fails or is still pending.
      void secondPromise.catch(() => {});

      const primer = await decodeSample(first, run);
      if (primer) {
        // Read synchronously by the gate, so the producer's one reused grid is
        // free again before the second sample is drawn through it.
        gate.observe(primer.grid, first.capturedAtMs);
      }

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
      diagnostics = {
        ...diagnostics,
        lastPairGapMs: gapMs,
        maxPairGapMs: Math.max(diagnostics.maxPairGapMs, gapMs),
      };
      if (gapMs > NATIVE_PAIR_MAX_GAP_MS) {
        diagnostics = {
          ...diagnostics,
          pairGapRejections: diagnostics.pairGapRejections + 1,
        };
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
      // The request lower bound prevents an in-flight pair from spending an
      // arm created after that request, even when native offsets postdate it.
      const decision = gate.offer(
        judged.grid,
        second.capturedAtMs,
        second.requestedAtMs,
      );
      diagnostics = {
        ...diagnostics,
        decisions: diagnostics.decisions + 1,
        keeps: diagnostics.keeps + Number(decision.keep),
      };
      onDecision(decision, second.capturedAtMs, judged.blob);
    } catch (err) {
      if (generation === run) {
        diagnostics = {
          ...diagnostics,
          sampleErrors: diagnostics.sampleErrors + 1,
        };
      }
      // A camera that stops answering is the common case, and the next tick is
      // its retry. Nothing a single sample can do is worth ending the poll.
      console.debug("[native-frame-source] sample failed:", err);
    } finally {
      if (generation === run) {
        reportDiagnostics("sampling");
      }
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
      reportDiagnostics("stopped");
    }
    timer = null;
  }

  function start(): void {
    stop();
    diagnostics = emptyDiagnostics();
    lastDiagnosticsAtMs = -Infinity;
    timer = setInterval(() => {
      void sampleOnce();
    }, intervalMs);
    reportDiagnostics("started");
  }

  return { start, sampleNow, invalidate, stop };
}
