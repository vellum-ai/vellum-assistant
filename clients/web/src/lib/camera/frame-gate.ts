/**
 * The live-vision frame gate: decides which viewfinder frames are worth
 * keeping, so an interval capture can run without flooding the conversation.
 *
 * ## What this is not
 *
 * It is not an image differ. It never sees an image. It sees a tiny grid of
 * luma samples and a timestamp, and answers keep or skip. Everything expensive
 * (encoding a JPEG, crossing the Capacitor bridge, uploading, persisting an
 * inline history image) happens only on a keep, which is the entire point: a
 * gate that has to encode a frame before rejecting it has not saved anything.
 *
 * Two samplers feed it the same {@link FrameGrid}. On the web path a `<video>`
 * is drawn to a small canvas; on iOS the native preview's existing
 * `AVCaptureVideoDataOutput` buffer is strided down in Swift. Keeping the
 * decision here rather than in each sampler is what lets the thresholds be
 * tuned in a browser and shipped to a phone unchanged.
 *
 * ## The two scores
 *
 * Both come from the same grid, which is why the gate needs only one per
 * frame:
 *
 * - `motion` compares the frame to the one immediately before it. It answers
 *   "is the camera settled right now". On a handheld phone this doubles as the
 *   blur check: a frame captured while the view is moving is a smeared frame,
 *   and settled and sharp are the same condition.
 * - `novelty` compares the frame to the last frame actually KEPT. It answers
 *   "is this worth sending".
 *
 * Comparing against the last kept frame rather than the previous frame is the
 * detail that makes a slow pan work. Frame to frame a slow pan never exceeds
 * any sane threshold, so a gate keyed on consecutive frames captures nothing
 * while the scene changes completely.
 *
 * ## Why the grid is normalized
 *
 * A phone's auto-exposure and auto-white-balance drift constantly, and a raw
 * pixel delta fires on a cloud crossing the sun. Each grid is z-scored (mean
 * subtracted, divided by its own standard deviation) before comparison, which
 * makes both scores invariant to global brightness and gain. The standard
 * deviation is floored, because a genuinely flat view (a phone pointed at a
 * white wall) has almost none, and dividing by it would amplify sensor noise
 * into a scene change. A frame with too little structure to normalize safely
 * is rejected outright: see {@link FrameGateOptions.minDetail}.
 *
 * Downscaling to {@link FRAME_GRID_SIZE} squared is itself the low-pass filter
 * that removes sensor noise and sub-pixel hand shake, so no separate blur or
 * denoise step is needed.
 *
 * ## The one case normalization cannot save
 *
 * Exposure invariance holds only while the sensor is not clipping. A hard
 * swing that blows out highlights or crushes shadows destroys information
 * rather than rescaling it, and no normalization recovers what was clipped.
 * Pointing a phone from a dim room at a bright window will therefore score as
 * a real change. That is a limitation to know about, not a bug to fix here:
 * the frame genuinely does look different, and the model would probably rather
 * see it than not.
 */

/**
 * Width and height of the comparison grid, in cells.
 *
 * 16 is chosen to be large enough that a change confined to one part of the
 * frame still moves the score, and small enough that the whole grid is 256
 * bytes: cheap to compute on a video callback thread and negligible to send
 * across the Capacitor bridge every frame.
 */
export const FRAME_GRID_SIZE = 16;

/** Number of cells in a {@link FrameGrid}. */
export const FRAME_GRID_CELLS = FRAME_GRID_SIZE * FRAME_GRID_SIZE;

/**
 * One frame reduced to grayscale luma, row-major, 0-255.
 *
 * A `Uint8Array` rather than floats because this is the wire format: the iOS
 * sampler produces exactly these bytes from the pixel buffer, and widening
 * them would triple the bridge payload for no precision that survives the
 * downscale.
 */
export type FrameGrid = Uint8Array;

/** Why the gate kept or skipped a frame. Surfaced for the tuning readout. */
export type FrameGateReason =
  /** Nothing has been kept yet, and the view has settled. */
  | "first"
  /** Enough changed against the last kept frame. */
  | "novel"
  /** Nothing changed, but the last keep is old enough to refresh. */
  | "heartbeat"
  /** Still inside the post-open warmup, where exposure has not converged. */
  | "warmup"
  /** A keep happened too recently. */
  | "rate-floor"
  /** The view is moving, so this frame is likely smeared. */
  | "moving"
  /** The view has almost no structure: a blank wall, or a hand over the lens. */
  | "featureless"
  /** Settled, recent enough, and materially the same as the last keep. */
  | "unchanged";

export interface FrameGateDecision {
  readonly keep: boolean;
  readonly reason: FrameGateReason;
  /**
   * Difference from the previous frame, or null when there was no previous
   * frame close enough in time for the number to mean anything. See
   * {@link FrameGateOptions.motionMaxAgeMs}.
   */
  readonly motion: number | null;
  /** Difference from the last kept frame, or null when nothing is kept yet. */
  readonly novelty: number | null;
  /**
   * How much spatial structure this frame has, as the standard deviation of
   * its luma in 0-255 units, before normalization. A photographic scene runs
   * in the tens; a blank wall or a palm over the lens is low single digits.
   */
  readonly detail: number;
}

export interface FrameGateOptions {
  /**
   * Novelty at or above which a settled frame is kept.
   *
   * In z-scored mean-absolute-difference units, so roughly: 0 is an identical
   * view, small values are the same scene from a slightly different angle, and
   * large ones are a different subject. Empirical, and the one number the
   * tuning rig exists to find.
   */
  readonly noveltyThreshold: number;
  /**
   * Motion at or above which the view counts as still moving. Measured in the
   * same units as novelty, but across a much shorter interval, so it is a much
   * smaller number.
   */
  readonly settleThreshold: number;
  /**
   * Shortest gap between two keeps. This, not the novelty threshold, is what
   * bounds the cost of the feature: pointed at a busy street every frame is
   * genuinely novel, and only a floor stops that from becoming a flood.
   */
  readonly minIntervalMs: number;
  /**
   * Longest gap between two keeps while the view is settled. Refreshes the
   * model's picture of a static scene, and is why a motionless camera does not
   * go silent forever.
   */
  readonly maxIntervalMs: number;
  /**
   * How long to wait for a settled frame before keeping a moving one anyway.
   *
   * Without this a camera in the hand of someone walking never settles and so
   * never sends, which is the one failure mode that looks exactly like the
   * feature being broken. A slightly smeared frame beats nothing at all.
   */
  readonly settleGraceMs: number;
  /**
   * Frames to ignore after {@link FrameGate.reset}, in milliseconds.
   *
   * A camera that has just started delivers badly exposed frames while
   * auto-exposure and white balance converge. On iOS these are visibly green
   * or black. Keeping one as the first thing the assistant sees is worse than
   * waiting.
   */
  readonly warmupMs: number;
  /**
   * Luma standard deviation below which a frame is treated as featureless and
   * never kept.
   *
   * Discovered by measurement rather than designed in. Normalization divides
   * by a frame's own deviation, so two frames of the same blank wall are two
   * fields of amplified sensor noise, and they score as a scene change against
   * each other. Flooring the divisor (see {@link MIN_GRID_DEVIATION}) bounds
   * that but does not remove it.
   *
   * Rejecting the frame outright is the better answer for a second reason that
   * has nothing to do with the arithmetic: a photograph of a blank wall or of
   * the user's palm is worthless to send. The case where the gate cannot tell
   * whether anything changed is the same case where nobody wants the picture.
   */
  readonly minDetail: number;
  /**
   * Maximum age of the previous frame for {@link FrameGateDecision.motion} to
   * be meaningful.
   *
   * Motion means "the view moved between two adjacent frames". At video rate
   * the gap is tens of milliseconds and the number is a real settle signal. If
   * frames arrive a second apart, a low value means the scene is static, not
   * that the camera is steady, and applying the settle check to it would
   * reject on the wrong evidence. Past this age the check is skipped and
   * `motion` is reported as null.
   */
  readonly motionMaxAgeMs: number;
}

/**
 * Calibrated against two handheld clips: one mostly moving, one fixed on a
 * subject while hands work on it. Not a shipped configuration, since two clips
 * are enough to rule values out but not to pin one.
 *
 * What the clips established:
 *
 * - Holding the phone still peaked at 0.0925 novelty on one clip and 0.039 on
 *   the other, against real auto-exposure and real sensor noise. The threshold
 *   sits an order of magnitude above that floor.
 * - Genuinely distinct views score around 1.0. The same subject from a
 *   slightly different angle scores 0.35 to 0.60, so a 0.35 threshold kept one
 *   storage box five times in a row.
 * - `noveltyThreshold` also controls SHARPNESS, which is not obvious. A lower
 *   threshold fires earlier, just as a scene settles into its new view. A
 *   higher one waits for more accumulated difference, by which point the
 *   camera is often moving again. At 0.8 both clips produced a keep above the
 *   settle threshold; at 0.6 neither produced any, while capturing more
 *   distinct subjects. Sharper photos from a lower bar.
 * - 0.6 costs roughly three near-duplicate frames out of nine on the moving
 *   clip. Both marginal keeps landed exactly on the threshold, which is what a
 *   well-placed bar looks like rather than a badly placed one.
 * - The rate floor, not the threshold, bounds the keep rate on moving footage:
 *   sweeping the threshold across the low range changes nothing there, because
 *   the floor gates every keep first. The threshold earns its keep on a fixed
 *   camera, where 30% of frames are turned away as unchanged.
 *
 * Which is why `minIntervalMs` is the other number to argue about. Images
 * persist inline in conversation history and are re-sent on every turn, so at
 * this floor a ten-minute call is on the order of a hundred images re-sent
 * repeatedly. Retention has to be solved alongside this regardless of tuning.
 */
export const DEFAULT_FRAME_GATE_OPTIONS: FrameGateOptions = {
  noveltyThreshold: 0.6,
  settleThreshold: 0.08,
  minIntervalMs: 5_000,
  maxIntervalMs: 30_000,
  settleGraceMs: 5_000,
  warmupMs: 600,
  minDetail: 8,
  motionMaxAgeMs: 120,
};

export interface FrameGate {
  /**
   * Offer one frame. `grid` is read synchronously and never retained, so a
   * caller may reuse a single scratch buffer for every frame.
   *
   * `nowMs` is a monotonic reading in milliseconds. The gate never reads a
   * clock itself, which is what makes it testable without faking time.
   */
  offer(grid: FrameGrid, nowMs: number): FrameGateDecision;
  /**
   * Drop all comparison history: no last-kept baseline, no previous frame,
   * and a fresh warmup window starting at `nowMs`. The one survivor is the
   * rate floor's clock: a keep made just before the reset still counts
   * against {@link FrameGateOptions.minIntervalMs}, because the floor bounds
   * cost and a reset does not refund the frame already sent.
   *
   * Call this when the camera opens, and on anything else that invalidates
   * comparison against earlier frames. A camera flip is the important one: the
   * front camera is mirrored and points somewhere else entirely, so every
   * score against a rear-camera baseline is meaningless.
   */
  reset(nowMs: number): void;
}

/**
 * Floor for a grid's standard deviation, in luma units, before it is used as a
 * normalizing divisor.
 *
 * A featureless view (a wall, a ceiling, a hand over the lens) has almost no
 * spatial variation, and what remains is sensor noise. Dividing by that would
 * scale noise up to the magnitude of real structure and make two frames of the
 * same blank wall look like a scene change.
 */
const MIN_GRID_DEVIATION = 6;

/**
 * Z-score `grid` into `out`: subtract the mean, divide by the deviation.
 *
 * This is what makes both scores invariant to exposure. Two frames of the same
 * scene at different brightness have the same normalized form.
 *
 * Returns the frame's UNFLOORED luma deviation, which is the detail measure
 * the featureless check reads. The floor applies to the divisor only.
 */
function normalizeGrid(grid: FrameGrid, out: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    sum += grid[i]!;
  }
  const mean = sum / FRAME_GRID_CELLS;

  let variance = 0;
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    const delta = grid[i]! - mean;
    variance += delta * delta;
  }
  const detail = Math.sqrt(variance / FRAME_GRID_CELLS);
  const divisor = Math.max(detail, MIN_GRID_DEVIATION);

  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    out[i] = (grid[i]! - mean) / divisor;
  }
  return detail;
}

/** Mean absolute difference between two normalized grids. */
function meanAbsoluteDifference(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    total += Math.abs(a[i]! - b[i]!);
  }
  return total / FRAME_GRID_CELLS;
}

/**
 * Create a gate.
 *
 * Allocation-free after construction: three fixed grids and no per-frame
 * garbage, so this can run on every frame of a video callback without
 * producing collection pressure during a live call.
 */
export function createFrameGate(
  options: FrameGateOptions = DEFAULT_FRAME_GATE_OPTIONS,
): FrameGate {
  const current = new Float32Array(FRAME_GRID_CELLS);
  const previous = new Float32Array(FRAME_GRID_CELLS);
  const kept = new Float32Array(FRAME_GRID_CELLS);

  let hasPrevious = false;
  let hasKept = false;
  let previousAtMs = 0;
  // When the last keep happened. Survives reset() on purpose: the rate floor
  // is the feature's cost bound, and a camera flip must not open a gap in it.
  let keptAtMs = Number.NEGATIVE_INFINITY;
  let warmupUntilMs = Number.NEGATIVE_INFINITY;
  // The first offer that got past warmup, which is the moment the very first
  // keep became possible. Only consulted before that first keep: afterwards
  // eligibility is governed by `minIntervalMs` instead.
  let firstEligibleAtMs: number | null = null;

  // Detail of the frame being decided right now. Held here rather than passed
  // through every helper: it is a property of `current`, which the helpers
  // already read from.
  let detail = 0;

  function rememberPrevious(nowMs: number): void {
    previous.set(current);
    hasPrevious = true;
    previousAtMs = nowMs;
  }

  function keepFrame(
    nowMs: number,
    reason: FrameGateReason,
    motion: number | null,
    novelty: number | null,
  ): FrameGateDecision {
    kept.set(current);
    hasKept = true;
    keptAtMs = nowMs;
    rememberPrevious(nowMs);
    return { keep: true, reason, motion, novelty, detail };
  }

  function skipFrame(
    nowMs: number,
    reason: FrameGateReason,
    motion: number | null,
    novelty: number | null,
  ): FrameGateDecision {
    rememberPrevious(nowMs);
    return { keep: false, reason, motion, novelty, detail };
  }

  return {
    offer(grid: FrameGrid, nowMs: number): FrameGateDecision {
      if (grid.length !== FRAME_GRID_CELLS) {
        throw new Error(
          `frame gate expects ${FRAME_GRID_CELLS} cells, received ${grid.length}`,
        );
      }

      detail = normalizeGrid(grid, current);

      // Motion is only trustworthy against a frame that arrived recently. See
      // `motionMaxAgeMs`: at one sample per second a small difference means
      // the scene is static, which is not the question being asked.
      const motion =
        hasPrevious && nowMs - previousAtMs <= options.motionMaxAgeMs
          ? meanAbsoluteDifference(current, previous)
          : null;
      const novelty = hasKept ? meanAbsoluteDifference(current, kept) : null;

      // Warmup is checked before everything else, including the first keep:
      // the frames it covers are the badly exposed ones, and the whole reason
      // to wait is to avoid making one of them the baseline.
      if (nowMs < warmupUntilMs) {
        return skipFrame(nowMs, "warmup", motion, novelty);
      }

      // Ahead of every keep path, including the first: a blank wall must not
      // become the baseline that everything afterwards is compared against.
      if (detail < options.minDetail) {
        return skipFrame(nowMs, "featureless", motion, novelty);
      }

      if (firstEligibleAtMs === null) {
        firstEligibleAtMs = nowMs;
      }
      const moving = motion !== null && motion >= options.settleThreshold;
      // The settle grace runs from the moment a keep became POSSIBLE, not from
      // the last frame offered: measuring from any earlier point would spend
      // the grace inside the rate floor, and the settle check would never
      // apply again. A keep becomes possible at the later of the first
      // post-warmup offer and the end of the floor, including the floor a
      // reset retains from a keep made just before it.
      const eligibleSinceMs = Math.max(
        firstEligibleAtMs,
        keptAtMs + options.minIntervalMs,
      );
      // Past the grace window a moving frame is kept anyway rather than
      // letting a walking user's camera go silent indefinitely.
      const forced = nowMs - eligibleSinceMs >= options.settleGraceMs;

      if (!hasKept) {
        // The baseline is gone after a reset, but the floor's clock is not: a
        // first keep is still a keep, and it pays the same minimum gap as any
        // other, so a flip right after a keep cannot raise the keep rate.
        if (nowMs - keptAtMs < options.minIntervalMs) {
          return skipFrame(nowMs, "rate-floor", motion, novelty);
        }
        if (moving && !forced) {
          return skipFrame(nowMs, "moving", motion, novelty);
        }
        return keepFrame(nowMs, "first", motion, novelty);
      }

      const sinceKeep = nowMs - keptAtMs;
      if (sinceKeep < options.minIntervalMs) {
        return skipFrame(nowMs, "rate-floor", motion, novelty);
      }
      if (moving && !forced) {
        return skipFrame(nowMs, "moving", motion, novelty);
      }
      if (sinceKeep >= options.maxIntervalMs) {
        return keepFrame(nowMs, "heartbeat", motion, novelty);
      }
      if (novelty !== null && novelty >= options.noveltyThreshold) {
        return keepFrame(nowMs, "novel", motion, novelty);
      }
      return skipFrame(nowMs, "unchanged", motion, novelty);
    },

    reset(nowMs: number): void {
      hasPrevious = false;
      hasKept = false;
      previousAtMs = 0;
      // `keptAtMs` is deliberately not cleared: comparison history is invalid
      // after a reset, but the cost of the last keep is already paid and the
      // rate floor still counts it.
      warmupUntilMs = nowMs + options.warmupMs;
      firstEligibleAtMs = null;
    },
  };
}
