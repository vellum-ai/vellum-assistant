/**
 * The frame gate's tuning readout: what each frame scored, which check decided
 * it, and the thresholds it was decided against.
 *
 * Two surfaces feed the same gate (the composer's sight tile and the voice
 * room's viewfinder) and both are hard to reason about from the outside,
 * because the only visible sign of a decision is a photo appearing or not
 * appearing. This module is the instrument: it collects every decision the
 * gate makes and lets the thresholds be moved while the camera is running.
 *
 * ## One options record, mutated in place
 *
 * `createFrameGate` captures its options object by reference and reads every
 * threshold on each `offer()`, so a slider only has to write into the record
 * the gate is already holding and the next frame is judged by the new value.
 *
 * That is not a convenience, it is the only safe way to do it. Rebuilding the
 * gate would reset its last-keep clock, which bypasses the rate floor and
 * fires an immediate keep, and on both surfaces a keep is a real upload and a
 * real persisted conversation message. So there is exactly one record, it
 * lives here for the lifetime of the tab, and nothing ever replaces it.
 *
 * ## Overrides apply only while the readout is on
 *
 * Turning the readout off copies the defaults back over the record. A
 * threshold someone moved while tuning can therefore never survive into a real
 * session, which is the failure this rule exists to prevent: an override is
 * invisible once the panel is gone, and a detuned gate looks like a broken
 * feature rather than a setting.
 *
 * ## What a frame costs when the readout is off
 *
 * One boolean read. Every entry point returns on the enable bit before it
 * touches anything, and there is no React or store write on the frame path at
 * all: decisions land in preallocated ring slots and subscribers are woken at
 * most once per animation frame.
 */

import {
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGateDecision,
  type FrameGateOptions,
  type FrameGateReason,
} from "./frame-gate";

/** Which camera surface a decision came from. */
export type FrameGateDebugSurface = "composer" | "voice";

/**
 * Zero for every reason, rebuilt per call so no caller can write into another's
 * counters. Spelled as a full record rather than derived from a list of reasons
 * so a reason added to the gate fails to compile here instead of silently
 * counting nothing.
 */
function emptyReasonCounts(): Record<FrameGateReason, number> {
  return {
    warmup: 0,
    featureless: 0,
    first: 0,
    "rate-floor": 0,
    moving: 0,
    heartbeat: 0,
    novel: 0,
    unchanged: 0,
    forced: 0,
  };
}

/** The thresholds a slider may move. */
export const FRAME_GATE_OVERRIDE_KEYS = [
  "noveltyThreshold",
  "settleThreshold",
  "minDetail",
  "minIntervalMs",
  "maxIntervalMs",
] as const;

export type FrameGateOverrideKey = (typeof FRAME_GATE_OVERRIDE_KEYS)[number];

/** A complete set of slider values. Every key is always present. */
export type FrameGateOverrides = Record<FrameGateOverrideKey, number>;

export interface FrameGateSliderBound {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * Slider range for each threshold, which is also the scale each meter is drawn
 * against. A meter and its slider share one range so the tick mark sits at the
 * same fraction of the bar as the slider's thumb.
 */
export const FRAME_GATE_SLIDER_BOUNDS: Record<
  FrameGateOverrideKey,
  FrameGateSliderBound
> = {
  noveltyThreshold: { min: 0, max: 2, step: 0.01 },
  settleThreshold: { min: 0, max: 0.5, step: 0.005 },
  minDetail: { min: 0, max: 60, step: 1 },
  minIntervalMs: { min: 0, max: 30_000, step: 250 },
  maxIntervalMs: { min: 1_000, max: 120_000, step: 1_000 },
};

/** The slider values that match the shipped gate. */
export function defaultFrameGateOverrides(): FrameGateOverrides {
  return {
    noveltyThreshold: DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold,
    settleThreshold: DEFAULT_FRAME_GATE_OPTIONS.settleThreshold,
    minDetail: DEFAULT_FRAME_GATE_OPTIONS.minDetail,
    minIntervalMs: DEFAULT_FRAME_GATE_OPTIONS.minIntervalMs,
    maxIntervalMs: DEFAULT_FRAME_GATE_OPTIONS.maxIntervalMs,
  };
}

type MutableFrameGateOptions = {
  -readonly [K in keyof FrameGateOptions]: FrameGateOptions[K];
};

/**
 * The one options record both gates read from, for the lifetime of the tab.
 *
 * Hand this to `createFrameGate` instead of {@link DEFAULT_FRAME_GATE_OPTIONS}.
 * It holds exactly the defaults until the readout is enabled and a slider
 * moves, and it goes back to holding exactly the defaults the moment the
 * readout is turned off, so a caller that never opens the panel is running the
 * shipped configuration.
 *
 * Never put this in an effect's dependency array: it is a stable reference on
 * purpose, and an effect that rebuilt a gate when a threshold moved would
 * reset the rate floor and fire an unwanted keep.
 */
const liveOptions: MutableFrameGateOptions = { ...DEFAULT_FRAME_GATE_OPTIONS };

export const FRAME_GATE_LIVE_OPTIONS: FrameGateOptions = liveOptions;

// ---------------------------------------------------------------------------
// Collected state
// ---------------------------------------------------------------------------

/** One judged frame. Slots are preallocated and overwritten, never replaced. */
interface DecisionSlot {
  keep: boolean;
  reason: FrameGateReason;
  motion: number | null;
  novelty: number | null;
  detail: number;
  atMs: number;
}

/** One judged frame, as the panel reads it. */
export interface FrameGateDebugDecision {
  readonly keep: boolean;
  readonly reason: FrameGateReason;
  readonly motion: number | null;
  readonly novelty: number | null;
  readonly detail: number;
  /** The sampler's monotonic reading for the frame, in milliseconds. */
  readonly atMs: number;
}

/** A kept frame held as an object URL for the thumbnail strip. */
export interface FrameGateDebugKeep {
  readonly url: string;
  readonly atMs: number;
}

/**
 * How many decisions the tape holds. A camera runs at video rate, so this is a
 * couple of seconds of history: long enough to see a burst of skips, short
 * enough to stay a fixed cost.
 */
const DECISION_RING_CAPACITY = 48;

/**
 * How many kept frames the strip holds. Each one pins a decoded full frame in
 * memory through its object URL, so the evicted one is revoked on the way out.
 */
const KEEP_RING_CAPACITY = 6;

/**
 * How long a surface stays the displayed one after its last decision.
 *
 * Frames arrive tens of milliseconds apart while a camera is open, so a gap
 * this long means the camera is gone. Without it the panel would sit on the
 * last decision of a camera that closed minutes ago, which reads as a live
 * readout of nothing.
 */
const SURFACE_IDLE_MS = 1_500;

interface SurfaceState {
  readonly decisions: DecisionSlot[];
  /** Total decisions written, so `% capacity` gives the next slot. */
  writes: number;
  reasonCounts: Record<FrameGateReason, number>;
  keeps: FrameGateDebugKeep[];
  /** Wall-clock of the last decision, for deciding whether it is still live. */
  lastSeenAt: number;
  /** Order of the last decision across both surfaces. Zero before the first. */
  lastSeq: number;
}

/**
 * Orders decisions across surfaces. A wall clock cannot: two cameras judging a
 * frame inside the same millisecond would tie, and the tie would have to be
 * broken by something other than which one is actually feeding the gate.
 */
let decisionSeq = 0;

function createSurfaceState(): SurfaceState {
  return {
    decisions: Array.from(
      { length: DECISION_RING_CAPACITY },
      (): DecisionSlot => ({
        keep: false,
        reason: "warmup",
        motion: null,
        novelty: null,
        detail: 0,
        atMs: 0,
      }),
    ),
    writes: 0,
    reasonCounts: emptyReasonCounts(),
    keeps: [],
    lastSeenAt: 0,
    lastSeq: 0,
  };
}

const surfaces: Record<FrameGateDebugSurface, SurfaceState> = {
  composer: createSurfaceState(),
  voice: createSurfaceState(),
};

let enabled = false;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface FrameGateDebugSnapshot {
  /**
   * Which surface the readout is showing, or null when neither has produced a
   * decision recently. The panel renders nothing on null.
   */
  readonly surface: FrameGateDebugSurface | null;
  /** Newest decision on {@link surface}, or null when there is none. */
  readonly latest: FrameGateDebugDecision | null;
  /** Newest first. At most {@link DECISION_RING_CAPACITY} entries. */
  readonly recent: readonly FrameGateDebugDecision[];
  /** Decisions on {@link surface} by the check that made them. */
  readonly reasonCounts: Readonly<Record<FrameGateReason, number>>;
  /** Newest first. At most {@link KEEP_RING_CAPACITY} entries. */
  readonly keeps: readonly FrameGateDebugKeep[];
  /** Decisions recorded on {@link surface} since the readout was enabled. */
  readonly total: number;
}

const EMPTY_SNAPSHOT: FrameGateDebugSnapshot = {
  surface: null,
  latest: null,
  recent: [],
  reasonCounts: emptyReasonCounts(),
  keeps: [],
  total: 0,
};

/**
 * Which surface the panel shows: whichever produced a decision most recently,
 * as long as it produced one recently enough to still be running a camera.
 */
function displayedSurface(): FrameGateDebugSurface | null {
  const cutoff = Date.now() - SURFACE_IDLE_MS;
  const { composer, voice } = surfaces;
  const voiceLive = voice.lastSeq > 0 && voice.lastSeenAt > cutoff;
  const composerLive = composer.lastSeq > 0 && composer.lastSeenAt > cutoff;
  if (voiceLive && (!composerLive || voice.lastSeq > composer.lastSeq)) {
    return "voice";
  }
  if (composerLive) {
    return "composer";
  }
  return null;
}

function readDecisions(state: SurfaceState): FrameGateDebugDecision[] {
  const held = Math.min(state.writes, DECISION_RING_CAPACITY);
  const out: FrameGateDebugDecision[] = [];
  for (let back = 1; back <= held; back++) {
    const slot =
      state.decisions[(state.writes - back) % DECISION_RING_CAPACITY]!;
    out.push({
      keep: slot.keep,
      reason: slot.reason,
      motion: slot.motion,
      novelty: slot.novelty,
      detail: slot.detail,
      atMs: slot.atMs,
    });
  }
  return out;
}

function buildSnapshot(): FrameGateDebugSnapshot {
  const surface = displayedSurface();
  if (!surface) {
    return EMPTY_SNAPSHOT;
  }
  const state = surfaces[surface];
  const recent = readDecisions(state);
  return {
    surface,
    latest: recent[0] ?? null,
    recent,
    reasonCounts: { ...state.reasonCounts },
    keeps: [...state.keeps].reverse(),
    total: state.writes,
  };
}

let snapshot: FrameGateDebugSnapshot = EMPTY_SNAPSHOT;

const listeners = new Set<() => void>();

/** Subscribe to the readout. Pairs with {@link getFrameGateDebugSnapshot}. */
export function subscribeFrameGateDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current readout. A stable reference between notifications, so it can be
 * read straight into `useSyncExternalStore`.
 */
export function getFrameGateDebugSnapshot(): FrameGateDebugSnapshot {
  return snapshot;
}

let framePending = false;
let idleHandle: ReturnType<typeof setTimeout> | null = null;

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Take the displayed surface down once its camera stops feeding the gate.
 *
 * Rearmed by every decision, so it only fires on the gap that means the camera
 * is gone rather than on the normal spacing between frames.
 */
function armIdleTimer(): void {
  if (idleHandle !== null) {
    clearTimeout(idleHandle);
  }
  idleHandle = setTimeout(() => {
    idleHandle = null;
    if (!enabled) {
      return;
    }
    publish();
  }, SURFACE_IDLE_MS);
}

/**
 * Wake subscribers at most once per animation frame.
 *
 * The gate judges every frame the camera delivers, and a React render per
 * frame would cost more than the feature being measured. Batching to the frame
 * also means the panel never renders a value the compositor would not show.
 */
function scheduleNotify(): void {
  if (framePending) {
    return;
  }
  framePending = true;
  const flush = (): void => {
    framePending = false;
    if (!enabled) {
      return;
    }
    publish();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush);
    return;
  }
  flush();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one gate decision, kept or skipped.
 *
 * Called from the sampler's `onDecision`, which is the video frame callback,
 * so the disabled path is one boolean read and nothing else.
 */
export function recordFrameGateDecision(
  surface: FrameGateDebugSurface,
  decision: FrameGateDecision,
  nowMs: number,
): void {
  if (!enabled) {
    return;
  }
  const state = surfaces[surface];
  const slot = state.decisions[state.writes % DECISION_RING_CAPACITY]!;
  slot.keep = decision.keep;
  slot.reason = decision.reason;
  slot.motion = decision.motion;
  slot.novelty = decision.novelty;
  slot.detail = decision.detail;
  slot.atMs = nowMs;
  state.writes += 1;
  state.reasonCounts[decision.reason] += 1;
  state.lastSeenAt = Date.now();
  decisionSeq += 1;
  state.lastSeq = decisionSeq;
  armIdleTimer();
  scheduleNotify();
}

/**
 * Record the frame a keep produced, for the thumbnail strip.
 *
 * Separate from {@link recordFrameGateDecision} because the two happen at
 * different moments: the decision is synchronous on the frame callback, and
 * the file exists only after an encode that the surface may still abandon.
 */
export function recordFrameGateKeep(
  surface: FrameGateDebugSurface,
  file: File,
): void {
  if (!enabled) {
    return;
  }
  const state = surfaces[surface];
  state.keeps.push({ url: URL.createObjectURL(file), atMs: Date.now() });
  while (state.keeps.length > KEEP_RING_CAPACITY) {
    const evicted = state.keeps.shift();
    if (evicted) {
      URL.revokeObjectURL(evicted.url);
    }
  }
  scheduleNotify();
}

// ---------------------------------------------------------------------------
// Enabling and overrides
// ---------------------------------------------------------------------------

/** Whether the readout is collecting. Read once per judged frame. */
export function isFrameGateDebugEnabled(): boolean {
  return enabled;
}

/**
 * A threshold both the gate and the readout can hold: inside its slider's
 * range, and the shipped default for anything unparseable.
 *
 * The per-key half of {@link normalizeFrameGateOverrides}, which is the seam
 * every value passes through on its way in.
 */
function clampFrameGateOverride(
  key: FrameGateOverrideKey,
  value: number,
): number {
  const bound = FRAME_GATE_SLIDER_BOUNDS[key];
  if (!Number.isFinite(value)) {
    return DEFAULT_FRAME_GATE_OPTIONS[key];
  }
  return Math.min(bound.max, Math.max(bound.min, value));
}

/**
 * A complete set every threshold of which the gate can honor: each value
 * inside its own slider's range, and the interval pair the right way round.
 *
 * The one seam a value passes through on its way into the store or the gate,
 * so a restored payload and a moved slider land on the same numbers the gate
 * applies. A readout drawing a value the gate is not using describes a session
 * that does not exist.
 *
 * The two intervals are one setting in two halves, not two settings. `offer`
 * reads the floor before the heartbeat, so a floor above the ceiling makes the
 * ceiling unreachable: the readout would draw a maximum no frame can ever be
 * judged against, which is the kind of session that teaches the reader
 * something untrue about the gate.
 *
 * `moved` names the threshold a writer just set, and the other half yields to
 * it, which is how a pair of coupled sliders behaves: pushing the floor up
 * carries the ceiling with it, pulling the ceiling down carries the floor.
 * Where nothing was moved, as when a stored payload is restored, the ceiling
 * rises to meet the floor.
 *
 * Ordering survives the clamp that follows it because the ceiling's range
 * covers the floor's: any floor value is reachable by the ceiling, and any
 * ceiling value at or above the floor's own minimum is reachable by the floor.
 */
export function normalizeFrameGateOverrides(
  overrides: FrameGateOverrides,
  moved?: FrameGateOverrideKey,
): FrameGateOverrides {
  const next = {} as FrameGateOverrides;
  for (const key of FRAME_GATE_OVERRIDE_KEYS) {
    next[key] = clampFrameGateOverride(key, overrides[key]);
  }
  if (next.minIntervalMs <= next.maxIntervalMs) {
    return next;
  }
  if (moved === "maxIntervalMs") {
    next.minIntervalMs = clampFrameGateOverride(
      "minIntervalMs",
      next.maxIntervalMs,
    );
    return next;
  }
  next.maxIntervalMs = clampFrameGateOverride(
    "maxIntervalMs",
    next.minIntervalMs,
  );
  return next;
}

function discardCollected(): void {
  if (idleHandle !== null) {
    clearTimeout(idleHandle);
    idleHandle = null;
  }
  for (const key of ["composer", "voice"] as const) {
    const state = surfaces[key];
    for (const keep of state.keeps) {
      URL.revokeObjectURL(keep.url);
    }
    state.keeps = [];
    state.writes = 0;
    state.reasonCounts = emptyReasonCounts();
    state.lastSeenAt = 0;
    state.lastSeq = 0;
  }
  snapshot = EMPTY_SNAPSHOT;
}

/**
 * Point the live options record at what the readout wants, and set the enable
 * bit, in one call.
 *
 * The single writer of {@link FRAME_GATE_LIVE_OPTIONS}, which is what makes
 * the enabled-only rule structural rather than a convention: a disabled
 * readout writes the defaults over the record no matter what the sliders hold,
 * so an override left behind by a tuning session cannot reach a real one.
 *
 * `next` is the effective state, not the persisted switch: a session that may
 * not reach the readout hands `false` here however that switch was left. See
 * `frame-gate-debug-access.ts`, which computes it.
 *
 * Values outside their slider's range, values a stale persisted payload left
 * as junk, and an interval pair the wrong way round are all put right by
 * {@link normalizeFrameGateOverrides} rather than reaching the gate. The store
 * holds an already-normalized set, so this pass is the identity on anything it
 * sends and the two cannot describe different thresholds.
 */
export function syncFrameGateDebugOptions(
  next: boolean,
  overrides: FrameGateOverrides,
): void {
  const wasEnabled = enabled;
  enabled = next;
  Object.assign(liveOptions, DEFAULT_FRAME_GATE_OPTIONS);
  if (next) {
    const applied = normalizeFrameGateOverrides(overrides);
    for (const key of FRAME_GATE_OVERRIDE_KEYS) {
      liveOptions[key] = applied[key];
    }
  }
  if (wasEnabled && !next) {
    discardCollected();
    for (const listener of [...listeners]) {
      listener();
    }
  }
}
