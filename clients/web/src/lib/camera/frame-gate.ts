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
  | "unchanged"
  /** A caller asked for a frame of this moment, whatever the thresholds say. */
  | "forced";

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

/**
 * How long an arm from {@link FrameGate.armForcedKeep} waits for a frame it can
 * keep.
 *
 * Wide enough for a sampler polling once a second to answer it, and for a
 * camera part-way through its warmup to finish. Narrow enough that the frame it
 * keeps is still of the scene the caller asked about: an arm nothing answered
 * expires rather than firing into whatever the camera is pointed at later.
 */
export const FRAME_GATE_FORCED_KEEP_TTL_MS = 2_000;

export interface FrameGate {
  /**
   * Offer one frame. `grid` is read synchronously and never retained, so a
   * caller may reuse a single scratch buffer for every frame.
   *
   * `nowMs` is a monotonic reading in milliseconds. The gate never reads a
   * clock itself, which is what makes it testable without faking time.
   *
   * `capturedSinceMs` is a lower bound on when the frame's picture was taken,
   * defaulting to `nowMs`. It exists for a source whose offers trail their
   * captures: a bridge call is issued, answers later, and decodes later still,
   * so `nowMs` is only an upper bound on the picture's age. The one decision
   * that needs the lower bound is a forced-keep arm, which must not be spent
   * on a picture from before the ask. A source that offers what its camera
   * shows right now leaves it unset.
   */
  offer(
    grid: FrameGrid,
    nowMs: number,
    capturedSinceMs?: number,
  ): FrameGateDecision;
  /**
   * Record one frame as the motion baseline, without judging it.
   *
   * {@link FrameGateDecision.motion} is only computed against a frame that
   * arrived within {@link FrameGateOptions.motionMaxAgeMs}, which a sampler
   * polling once a second cannot produce out of consecutive offers: every
   * offer would report no motion, and the settle check would never run. Such a
   * sampler takes a PAIR instead. The first frame comes in here, the second is
   * offered, and the offer's motion is measured across the pair's spacing
   * rather than across the poll interval.
   *
   * This does exactly what every {@link FrameGate.offer} already does on its
   * way out, and nothing else. A frame passed here can never be kept, does not
   * become the novelty baseline, does not move the rate floor, does not end
   * warmup, and does not start the settle grace. The only thing it can change
   * about the next offer is that offer's motion.
   */
  observe(grid: FrameGrid, nowMs: number): void;
  /**
   * Ask for the next usable frame to be kept, whatever the thresholds say.
   *
   * The gate judges a frame against the ones around it, and there is one thing
   * it cannot see: the moment the user starts asking about what the camera is
   * pointed at. The ambient cadence answers that question with whichever frame
   * it last thought was worth sending, which on a camera that has just moved is
   * the scene before this one. An arm makes the current scene the one that
   * lands.
   *
   * One shot, and it expires {@link FRAME_GATE_FORCED_KEEP_TTL_MS} after
   * `nowMs`. Warmup and the detail floor still refuse it, because a frame taken
   * before exposure converged or of a palm over the lens answers nobody's
   * question and would poison the baseline everything afterwards is compared
   * against. Everything else is skipped: the rate floor, the settle check,
   * novelty and the heartbeat. The keep is recorded exactly as an ambient one,
   * so the next frame is judged against it rather than firing again behind it.
   *
   * `nowMs` is also the arm's lower bound: only a frame whose picture provably
   * postdates it may spend it. The proof an offer carries is its
   * `capturedSinceMs`, the earliest its picture can have been taken, and a
   * frame whose bound falls before the arm was taken before the ask: exactly
   * the stale scene the arm exists to get past. Such a frame is judged as an
   * ambient one and leaves the arm standing for the first frame whose bound
   * reaches it. The comparison only means something because the arm and the
   * offers are stamped from one clock, which every caller of this gate reads
   * from `performance.now`.
   */
  armForcedKeep(nowMs: number): void;
  /**
   * Drop all comparison history: no last-kept baseline, no previous frame,
   * and a fresh warmup window starting at `nowMs`. The one survivor is the
   * rate floor's clock: a keep made just before the reset still counts
   * against {@link FrameGateOptions.minIntervalMs}, because the floor bounds
   * cost and a reset does not refund the frame already sent.
   *
   * An unspent arm goes with the history. It was made about a scene this gate
   * can no longer score against, and the camera the next frame comes from may
   * not even be the one it was made for.
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
 * The checks `offer` runs before it has a kept frame to compare against, in
 * the order it runs them. Ends at the keep that establishes the baseline.
 */
const FIRST_KEEP_PATH = [
  "warmup",
  "featureless",
  "forced",
  "rate-floor",
  "moving",
  "first",
] as const satisfies readonly FrameGateReason[];

/** The checks `offer` runs once a baseline exists, in the order it runs them. */
const BASELINE_PATH = [
  "warmup",
  "featureless",
  "forced",
  "rate-floor",
  "moving",
  "heartbeat",
  "novel",
  "unchanged",
] as const satisfies readonly FrameGateReason[];

/**
 * The checks that were on the table for one decision, in the order `offer`
 * runs them, ending at the one that could not be got past.
 *
 * `offer` is not a single list of checks: it branches on whether a kept frame
 * exists, and the two branches share only their first four steps. A reader
 * needs the branch that was actually taken, because "the checks above the
 * highlighted one all passed" is the whole value of seeing the order, and a
 * flattened list makes that claim about checks the frame never reached.
 *
 * The decision identifies its own branch. `offer` computes
 * {@link FrameGateDecision.novelty} as the difference from the last kept frame
 * before any check runs, so it is null on exactly the frames judged without a
 * baseline. Reading the branch back off the decision is what keeps this
 * function honest: there is no second copy of the control flow to forget to
 * update, only the same condition `offer` itself branched on.
 */
export function frameGateDecisionPath(
  decision: Pick<FrameGateDecision, "novelty">,
): readonly FrameGateReason[] {
  return decision.novelty === null ? FIRST_KEEP_PATH : BASELINE_PATH;
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
  // An unspent arm from `armForcedKeep`, or null when nothing is armed.
  // `sinceMs` is when it was made, and only a frame whose capture lower bound
  // reaches it may spend it: an offer can carry a capture from before the
  // ask, which is the very scene the arm exists to get past. `untilMs` is
  // when it stops being answerable at all.
  let forcedArm: { sinceMs: number; untilMs: number } | null = null;

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
    offer(
      grid: FrameGrid,
      nowMs: number,
      capturedSinceMs?: number,
    ): FrameGateDecision {
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

      // Ahead of the vetoes below, so an arm that ran out while the camera had
      // nothing worth keeping is dropped rather than spent on the first frame
      // past them: it was asked for a scene a whole window ago.
      if (forcedArm !== null && nowMs > forcedArm.untilMs) {
        forcedArm = null;
      }

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

      // Only a frame whose picture provably postdates the arm may spend it: a
      // native offer can carry a capture from before the ask, however late its
      // stamp lands, and force-keeping that one would send the stale scene the
      // arm exists to get past. It falls through to the ambient rules and the
      // arm stands for the next fresh frame.
      // Through `keepFrame` like every other keep, so the rate floor's clock
      // and both baselines move with it and the next ambient frame is judged
      // against this one instead of firing again behind it.
      if (
        forcedArm !== null &&
        (capturedSinceMs ?? nowMs) >= forcedArm.sinceMs
      ) {
        forcedArm = null;
        return keepFrame(nowMs, "forced", motion, novelty);
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
      const graceExpired = nowMs - eligibleSinceMs >= options.settleGraceMs;

      if (!hasKept) {
        // The baseline is gone after a reset, but the floor's clock is not: a
        // first keep is still a keep, and it pays the same minimum gap as any
        // other, so a flip right after a keep cannot raise the keep rate.
        if (nowMs - keptAtMs < options.minIntervalMs) {
          return skipFrame(nowMs, "rate-floor", motion, novelty);
        }
        if (moving && !graceExpired) {
          return skipFrame(nowMs, "moving", motion, novelty);
        }
        return keepFrame(nowMs, "first", motion, novelty);
      }

      const sinceKeep = nowMs - keptAtMs;
      if (sinceKeep < options.minIntervalMs) {
        return skipFrame(nowMs, "rate-floor", motion, novelty);
      }
      if (moving && !graceExpired) {
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

    observe(grid: FrameGrid, nowMs: number): void {
      if (grid.length !== FRAME_GRID_CELLS) {
        throw new Error(
          `frame gate expects ${FRAME_GRID_CELLS} cells, received ${grid.length}`,
        );
      }
      // `current` is scratch that every offer normalizes into again before
      // reading, and `detail` is deliberately left alone: it describes the
      // frame being decided, and this one is not being decided.
      normalizeGrid(grid, current);
      rememberPrevious(nowMs);
    },

    armForcedKeep(nowMs: number): void {
      forcedArm = {
        sinceMs: nowMs,
        untilMs: nowMs + FRAME_GATE_FORCED_KEEP_TTL_MS,
      };
    },

    reset(nowMs: number): void {
      hasPrevious = false;
      hasKept = false;
      previousAtMs = 0;
      forcedArm = null;
      // `keptAtMs` is deliberately not cleared: comparison history is invalid
      // after a reset, but the cost of the last keep is already paid and the
      // rate floor still counts it.
      warmupUntilMs = nowMs + options.warmupMs;
      firstEligibleAtMs = null;
    },
  };
}
