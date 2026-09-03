/**
 * Tests for the live-vision frame gate.
 *
 * These are the spike's answer to the first risk: does a 16x16 normalized
 * difference actually separate "the view changed" from the three things that
 * move pixels without meaning anything on a handheld phone, namely exposure
 * drift, sensor noise, and hand shake.
 *
 * The frames are synthetic on purpose. Real footage tunes the thresholds, but
 * it cannot prove the state machine, because a recorded clip cannot be replayed
 * with one variable changed at a time. A generated scene can: the exposure test
 * below changes gain and offset and NOTHING else, which is the only way to show
 * that invariance is a property of the gate rather than a property of the clip.
 *
 * What these tests do NOT establish is any absolute threshold value. The
 * calibration notes live in the description of the PR that introduced this
 * module (#41659).
 */

import { describe, expect, test } from "bun:test";

import {
  createFrameGate,
  DEFAULT_FRAME_GATE_OPTIONS,
  frameGateDecisionPath,
  FRAME_GATE_FORCED_KEEP_TTL_MS,
  FRAME_GRID_CELLS,
  FRAME_GRID_SIZE,
  type FrameGateDecision,
  type FrameGateOptions,
  type FrameGateReason,
  type FrameGrid,
} from "./frame-gate";

/**
 * Short intervals so a test can span several keeps in a readable number of
 * frames. The thresholds are the real defaults: the timing is what is being
 * made convenient, not the decision.
 */
const TEST_OPTIONS: FrameGateOptions = {
  ...DEFAULT_FRAME_GATE_OPTIONS,
  // Pinned rather than inherited. These tests cover the mechanism, and the
  // shipped tuning moves as real footage accumulates: coupling the two makes a
  // threshold change look like a broken state machine.
  noveltyThreshold: 0.35,
  minIntervalMs: 100,
  maxIntervalMs: 1_000,
  settleGraceMs: 200,
  warmupMs: 0,
};

/**
 * Score bounds the metric must satisfy for ANY workable threshold to exist.
 *
 * Both are calibrated against the real clip, not invented: nine seconds of
 * deliberately holding a phone still peaked at 0.0925 novelty, and genuinely
 * distinct views scored 0.97 to 1.12. These constants bracket that gap with
 * margin. If a change to the metric pushes a nuisance case above the ceiling
 * or a real change below the floor, no single threshold divides them any more
 * and the approach itself is in trouble, which is what these assert.
 */
const NUISANCE_CEILING = 0.15;
const SIGNAL_FLOOR = 0.3;

/** Deterministic RNG, so a threshold assertion cannot flake. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampLuma(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * A synthetic scene with real spatial structure.
 *
 * Structure matters: a grid of uniform random values has no correlation
 * between neighbours, so every comparison against it looks like a scene change
 * and the tests would pass for the wrong reason. This has edges and gradients,
 * which is what a downscaled photograph looks like.
 *
 * `panX` slides the sampling window horizontally, which is how a pan is
 * simulated without needing a larger source image.
 */
function scene({ seed, panX = 0 }: { seed: number; panX?: number }): FrameGrid {
  const grid = new Uint8Array(FRAME_GRID_CELLS);
  for (let y = 0; y < FRAME_GRID_SIZE; y++) {
    for (let x = 0; x < FRAME_GRID_SIZE; x++) {
      const sx = x + panX;
      const value =
        128 +
        60 * Math.sin((sx + seed * 7) * 0.4) +
        40 * Math.cos((y + seed * 3) * 0.6) +
        30 * Math.sin((sx * y + seed * 11) * 0.11);
      grid[y * FRAME_GRID_SIZE + x] = clampLuma(value);
    }
  }
  return grid;
}

/** Apply a gain and offset, as auto-exposure and auto-white-balance do. */
function exposed(
  grid: FrameGrid,
  { gain, offset }: { gain: number; offset: number },
): FrameGrid {
  const out = new Uint8Array(FRAME_GRID_CELLS);
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    out[i] = clampLuma(grid[i]! * gain + offset);
  }
  return out;
}

/** Add zero-mean sensor noise of the given amplitude in luma units. */
function noisy(
  grid: FrameGrid,
  amplitude: number,
  random: () => number,
): FrameGrid {
  const out = new Uint8Array(FRAME_GRID_CELLS);
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    out[i] = clampLuma(grid[i]! + (random() * 2 - 1) * amplitude);
  }
  return out;
}

/** A hand over the lens: near-uniform and dark, with a little noise. */
function occluded(random: () => number): FrameGrid {
  const out = new Uint8Array(FRAME_GRID_CELLS);
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    out[i] = clampLuma(38 + (random() * 2 - 1) * 4);
  }
  return out;
}

/** A blank wall: bright, near-uniform, nothing to photograph. */
function flatWall(random: () => number): FrameGrid {
  const out = new Uint8Array(FRAME_GRID_CELLS);
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    out[i] = clampLuma(180 + (random() * 2 - 1) * 3);
  }
  return out;
}

/** Novelty of `candidate` against a gate whose last keep was `baseline`. */
function noveltyBetween(baseline: FrameGrid, candidate: FrameGrid): number {
  const gate = createFrameGate(TEST_OPTIONS);
  gate.reset(0);
  gate.offer(baseline, 0);
  // Far enough apart that the settle check is skipped, so the reported novelty
  // is not shadowed by a "moving" decision.
  const decision = gate.offer(candidate, 10_000);
  return decision.novelty ?? Number.NaN;
}

describe("createFrameGate", () => {
  test("rejects a grid of the wrong size", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    expect(() => gate.offer(new Uint8Array(64), 0)).toThrow(
      /expects 256 cells, received 64/,
    );
  });

  test("keeps the first settled frame after the camera opens", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    const decision = gate.offer(scene({ seed: 1 }), 0);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("first");
    // Nothing to compare against yet, so both scores are honestly absent
    // rather than reported as zero.
    expect(decision.motion).toBeNull();
    expect(decision.novelty).toBeNull();
  });

  test("skips frames inside the post-open warmup", () => {
    const gate = createFrameGate({ ...TEST_OPTIONS, warmupMs: 600 });
    gate.reset(0);
    expect(gate.offer(scene({ seed: 1 }), 0).reason).toBe("warmup");
    expect(gate.offer(scene({ seed: 1 }), 599).reason).toBe("warmup");
    // The first frame past the window becomes the baseline, so a badly exposed
    // opening frame is never what the assistant sees first.
    expect(gate.offer(scene({ seed: 1 }), 600).keep).toBe(true);
  });
});

describe("frame gate invariance", () => {
  /**
   * The headline invariant. A phone re-exposing is the single most common
   * whole-frame pixel change there is, and a gate that fires on it would send
   * a photo every time a cloud moved.
   */
  test("an exposure change alone is not novelty", () => {
    const base = scene({ seed: 2 });
    const brighter = exposed(base, { gain: 1.15, offset: 22 });
    const darker = exposed(base, { gain: 0.85, offset: -18 });

    expect(noveltyBetween(base, brighter)).toBeLessThan(NUISANCE_CEILING);
    expect(noveltyBetween(base, darker)).toBeLessThan(NUISANCE_CEILING);
  });

  test("sensor noise alone is not novelty", () => {
    const random = makeRandom(7);
    const base = scene({ seed: 3 });
    const sameViewAgain = noisy(base, 6, random);

    expect(noveltyBetween(base, sameViewAgain)).toBeLessThan(NUISANCE_CEILING);
  });

  test("a different scene is novelty, by a wide margin", () => {
    const base = scene({ seed: 4 });
    const different = scene({ seed: 40 });
    const cutScore = noveltyBetween(base, different);

    expect(cutScore).toBeGreaterThan(SIGNAL_FLOOR);
    // The separation is what makes the threshold tunable at all: if a scene cut
    // and an exposure change landed near each other, no single number would
    // divide them and the whole approach would be wrong. Measured separation on
    // these fixtures is roughly 10x; asserted at 5x because the exact ratio is
    // a property of the chosen seeds, and a test that sits a few percent from
    // failing is a flake waiting for someone to add a fixture.
    const exposureScore = noveltyBetween(
      base,
      exposed(base, { gain: 1.15, offset: 22 }),
    );
    expect(cutScore).toBeGreaterThan(exposureScore * 5);
  });

  /**
   * The limitation, pinned so it is a known property rather than a surprise in
   * the field. Clipping destroys information instead of rescaling it, so no
   * normalization recovers it and the frame genuinely does look different.
   */
  test("a clipping exposure swing defeats invariance, by design", () => {
    const base = scene({ seed: 2 });
    const blownOut = exposed(base, { gain: 1.5, offset: 40 });
    expect(noveltyBetween(base, blownOut)).toBeGreaterThan(
      noveltyBetween(base, exposed(base, { gain: 1.15, offset: 22 })) * 3,
    );
  });
});

describe("frame gate featureless rejection", () => {
  /**
   * Both of these exist because of a measured failure, not a predicted one.
   * Two frames of the same blank wall scored 0.33 against each other, just
   * under the 0.35 keep threshold, because normalization divides a featureless
   * frame by its own sensor noise. Rejecting on absolute detail is the fix, and
   * it is the right behaviour independently: nobody wants a photo of a wall.
   */
  test("skips a hand over the lens instead of sending it", () => {
    const random = makeRandom(11);
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 5 }), 0);

    const decision = gate.offer(occluded(random), 10_000);
    expect(decision.keep).toBe(false);
    expect(decision.reason).toBe("featureless");
    expect(decision.detail).toBeLessThan(TEST_OPTIONS.minDetail);
  });

  test("never makes a blank wall the baseline", () => {
    const random = makeRandom(13);
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);

    // A camera opening while face-down on a table. Keeping this frame would
    // both send a useless photo and poison every comparison after it.
    const decision = gate.offer(flatWall(random), 0);
    expect(decision.reason).toBe("featureless");

    // Lifting the phone off the table reads as movement, because it is: the
    // rejected frame is still the motion reference even though it was never
    // kept. One settled frame later the gate takes its first keep, which is
    // what proves the wall never became a baseline.
    expect(gate.offer(scene({ seed: 14 }), 100).reason).toBe("moving");
    const settled = gate.offer(scene({ seed: 14 }), 133);
    expect(settled.reason).toBe("first");
    expect(settled.novelty).toBeNull();
  });

  test("a real scene clears the detail floor with room to spare", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    // Guards the fixtures as much as the gate: if the synthetic scenes drifted
    // below the floor, every other test here would pass for the wrong reason.
    expect(gate.offer(scene({ seed: 15 }), 0).detail).toBeGreaterThan(
      TEST_OPTIONS.minDetail * 3,
    );
  });
});

describe("frame gate settle behaviour", () => {
  test("skips a moving view rather than keeping a smeared frame", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 6 }), 0);

    // Frames 33 ms apart, panning fast. Inside `motionMaxAgeMs`, so motion is
    // real evidence.
    let time = 33;
    let sawMoving = false;
    for (let step = 1; step <= 12; step++) {
      const decision = gate.offer(scene({ seed: 6, panX: step * 2 }), time);
      if (decision.reason === "moving") {
        sawMoving = true;
      }
      time += 33;
    }
    expect(sawMoving).toBe(true);
  });

  test("reports no motion when frames arrive too far apart to judge", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 7 }), 0);

    // One sample per second is the naive interval design. A low difference here
    // would mean the scene is static, not that the camera is steady, so the
    // gate declines to call it motion at all.
    const decision = gate.offer(scene({ seed: 7, panX: 6 }), 1_000);
    expect(decision.motion).toBeNull();
    expect(decision.reason).not.toBe("moving");
  });

  test("keeps a moving frame once the settle grace expires", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 8 }), 0);

    // A camera that never settles, as in someone's hand while they walk. The
    // failure this guards against is silence that looks exactly like the
    // feature being broken.
    let time = 33;
    let keptWhileMoving = false;
    while (time < 2_000) {
      const decision = gate.offer(
        scene({ seed: 8, panX: Math.round(time / 20) }),
        time,
      );
      if (
        decision.keep &&
        (decision.motion ?? 0) >= TEST_OPTIONS.settleThreshold
      ) {
        keptWhileMoving = true;
        break;
      }
      time += 33;
    }
    expect(keptWhileMoving).toBe(true);
  });
});

describe("frame gate keep policy", () => {
  test("a slow pan is eventually kept, because novelty accumulates", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 9 }), 0);

    // This is the case that a previous-frame comparison cannot catch: each
    // frame is nearly identical to the one before it, so a consecutive-frame
    // gate would capture nothing while the view changed completely.
    let time = 200;
    let kept = false;
    for (let step = 1; step <= 60; step++) {
      // A quarter cell per frame: below any sane settle threshold.
      const decision = gate.offer(scene({ seed: 9, panX: step * 0.25 }), time);
      if (decision.keep) {
        kept = true;
        expect(decision.reason).toBe("novel");
        break;
      }
      time += 200;
    }
    expect(kept).toBe(true);
  });

  test("refreshes a completely static view on the heartbeat", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    const still = scene({ seed: 10 });
    gate.offer(still, 0);

    // Nothing changes at all, so novelty never fires. Without a heartbeat the
    // assistant's picture of the room would be frozen at whatever it saw first.
    expect(gate.offer(still, 500).reason).toBe("unchanged");
    const beat = gate.offer(still, 1_000);
    expect(beat.keep).toBe(true);
    expect(beat.reason).toBe("heartbeat");
  });

  test("the rate floor bounds the keep rate on a saturating view", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);

    // The busy-street case: a new scene every other frame, each held for one
    // repeat so a settled, wildly novel frame arrives about every 66 ms. That
    // asks for far more keeps than the floor's one per 100 ms, and the settle
    // check cannot be what limits them, so only the floor stands between this
    // and a flood. This is the assertion that bounds the feature's cost.
    const frames = 300;
    const frameGapMs = 33;
    let keeps = 0;
    let time = 0;
    for (let step = 0; step < frames; step++) {
      if (gate.offer(scene({ seed: 100 + Math.floor(step / 2) }), time).keep) {
        keeps += 1;
      }
      time += frameGapMs;
    }
    // Offered ~150 settled novel frames; the floor admits at most one per
    // `minIntervalMs`. The upper bound sits far below both the offered frame
    // count and the eligible-keep count, so removing or breaking the
    // rate-floor rung fails this assertion rather than slipping past it. The
    // lower bound proves the gate is keeping near the floor's rate instead of
    // going silent.
    const elapsedMs = frames * frameGapMs;
    const floorBound = Math.floor(elapsedMs / TEST_OPTIONS.minIntervalMs) + 1;
    expect(keeps).toBeLessThanOrEqual(floorBound);
    expect(keeps).toBeGreaterThanOrEqual(Math.floor(floorBound / 2));
  });
});

describe("frame gate reset", () => {
  test("a flip invalidates the baseline instead of reporting a scene change", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 12 }), 0);

    // The front camera is mirrored and points somewhere else, so every score
    // against the rear camera's baseline would be meaningless. After a reset
    // the next frame is a first keep, not a novelty keep.
    gate.reset(1_000);
    const afterFlip = gate.offer(scene({ seed: 120 }), 1_000);
    expect(afterFlip.reason).toBe("first");
    expect(afterFlip.novelty).toBeNull();
  });

  test("a reset does not open a gap in the rate floor", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    expect(gate.offer(scene({ seed: 16 }), 0).keep).toBe(true);

    // A flip right on the heels of a keep. The baseline is rightly gone, but
    // the keep was already paid for, so the next keep still waits out the
    // floor: otherwise flipping back and forth doubles the keep rate.
    gate.reset(20);
    const tooSoon = gate.offer(scene({ seed: 160 }), 50);
    expect(tooSoon.keep).toBe(false);
    expect(tooSoon.reason).toBe("rate-floor");

    const afterFloor = gate.offer(scene({ seed: 160 }), 150);
    expect(afterFloor.keep).toBe(true);
    expect(afterFloor.reason).toBe("first");
    expect(afterFloor.novelty).toBeNull();
  });

  test("the settle grace after a reset waits out the retained rate floor", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    expect(gate.offer(scene({ seed: 18 }), 0).keep).toBe(true);

    // A flip right after a keep, with the camera still moving. A keep becomes
    // possible only when the retained floor expires at 100 ms, so the settle
    // check owns the full grace from there and the earliest forced keep lands
    // at 300 ms. Anchoring the grace at the first post-reset offer instead
    // would force a smeared keep the moment the floor opens.
    gate.reset(10);
    let firstKeepAtMs: number | null = null;
    for (let step = 0; step < 12; step++) {
      const time = 20 + step * 33;
      const decision = gate.offer(scene({ seed: 18, panX: step * 2 }), time);
      if (decision.keep) {
        firstKeepAtMs = time;
        break;
      }
    }
    expect(firstKeepAtMs).not.toBeNull();
    expect(firstKeepAtMs!).toBeGreaterThanOrEqual(
      TEST_OPTIONS.minIntervalMs + TEST_OPTIONS.settleGraceMs,
    );
  });
});

/**
 * The readout draws the checks a frame was put through, and claims everything
 * above the deciding one passed. That claim is only true if the list is the
 * branch `offer` actually took, so these tests hold the published path against
 * decisions a real gate produced rather than against a second reading of the
 * control flow.
 */
describe("frame gate decision path", () => {
  /**
   * Spelled as a full record rather than a list so a reason added to the gate
   * fails to compile here instead of quietly going untested.
   */
  const ALL_REASONS = Object.keys({
    warmup: true,
    featureless: true,
    first: true,
    "rate-floor": true,
    moving: true,
    heartbeat: true,
    novel: true,
    unchanged: true,
    forced: true,
  } satisfies Record<FrameGateReason, true>) as FrameGateReason[];

  /** The checks that need a kept frame to score against. */
  const BASELINE_ONLY_REASONS = [
    "heartbeat",
    "novel",
    "unchanged",
  ] as const satisfies readonly FrameGateReason[];

  /**
   * One scripted camera session that reaches every check, on both branches.
   *
   * The timings are chosen against {@link TEST_OPTIONS} to walk the gate
   * through warmup, a wall, a swing, a settle, the floor, a repeat view, a new
   * view, a long idle, and a second swing, then a flip that drops the baseline
   * while the floor's clock survives it.
   */
  function collectDecisions(): FrameGateDecision[] {
    const wall = flatWall(makeRandom(7));
    const decisions: FrameGateDecision[] = [];

    const gate = createFrameGate({ ...TEST_OPTIONS, warmupMs: 600 });
    gate.reset(0);
    decisions.push(gate.offer(scene({ seed: 1 }), 0));
    decisions.push(gate.offer(wall, 600));
    decisions.push(gate.offer(scene({ seed: 1 }), 700));
    decisions.push(gate.offer(scene({ seed: 1 }), 900));
    decisions.push(gate.offer(scene({ seed: 1 }), 950));
    decisions.push(gate.offer(scene({ seed: 1 }), 1_100));
    decisions.push(gate.offer(scene({ seed: 9 }), 1_250));
    decisions.push(gate.offer(scene({ seed: 9 }), 2_300));
    decisions.push(gate.offer(scene({ seed: 9 }), 2_400));
    decisions.push(gate.offer(scene({ seed: 3 }), 2_450));
    gate.armForcedKeep(2_460);
    decisions.push(gate.offer(scene({ seed: 3 }), 2_470));

    const flipped = createFrameGate(TEST_OPTIONS);
    flipped.reset(0);
    decisions.push(flipped.offer(scene({ seed: 1 }), 0));
    flipped.reset(10);
    decisions.push(flipped.offer(scene({ seed: 1 }), 50));

    return decisions;
  }

  test("the scripted session reaches every check the gate can decide on", () => {
    const reached = new Set(collectDecisions().map((d) => d.reason));

    expect([...reached].sort()).toEqual([...ALL_REASONS].sort());
  });

  test("every decision names a check on the path it was judged against", () => {
    for (const decision of collectDecisions()) {
      expect(frameGateDecisionPath(decision)).toContain(decision.reason);
    }
  });

  test("a frame judged with no baseline lists no check that needs one", () => {
    const withoutBaseline = collectDecisions().filter(
      (d) => d.novelty === null,
    );
    expect(withoutBaseline.length).toBeGreaterThan(0);

    for (const decision of withoutBaseline) {
      const path = frameGateDecisionPath(decision);
      for (const reason of BASELINE_ONLY_REASONS) {
        expect(path).not.toContain(reason);
      }
    }
  });

  test("the first keep is only ever on the path taken without a baseline", () => {
    const decisions = collectDecisions();
    expect(decisions.some((d) => d.reason === "first")).toBe(true);

    for (const decision of decisions) {
      if (decision.reason === "first") {
        expect(decision.novelty).toBeNull();
      }
      if (decision.novelty !== null) {
        expect(frameGateDecisionPath(decision)).not.toContain("first");
      }
    }
  });

  test("the floor is checked before the first keep, not after it", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    expect(gate.offer(scene({ seed: 1 }), 0).reason).toBe("first");

    // A flip drops the baseline and keeps the floor's clock, so the next frame
    // is turned away by the floor with nothing kept to score it against.
    gate.reset(10);
    const decision = gate.offer(scene({ seed: 1 }), 50);
    expect(decision.reason).toBe("rate-floor");
    expect(decision.novelty).toBeNull();

    const path = frameGateDecisionPath(decision);
    expect(path.indexOf("rate-floor")).toBeLessThan(path.indexOf("first"));
  });
});

/**
 * The record-only primer.
 *
 * A sampler polling once a second cannot produce two frames close enough
 * together for motion to mean anything, so it takes a pair and primes the gate
 * with the first. That makes `observe` a second entry point into a shared
 * engine, and the property that matters is that it is inert: it moves the
 * motion baseline and nothing else, so no existing decision path can be
 * reached differently because a caller primed a frame first.
 */
describe("frame gate primer", () => {
  test("gives the next offer a motion reading it would not otherwise have", () => {
    const still = scene({ seed: 4 });
    const panned = scene({ seed: 4, panX: 3 });

    const unprimed = createFrameGate(TEST_OPTIONS);
    unprimed.reset(0);
    // A whole poll interval apart, which is what the native cadence produces.
    unprimed.offer(still, 1_000);
    expect(unprimed.offer(panned, 2_000).motion).toBeNull();

    const primed = createFrameGate(TEST_OPTIONS);
    primed.reset(0);
    primed.offer(still, 1_000);
    primed.observe(still, 2_000);
    // The pair's spacing, well inside `motionMaxAgeMs`.
    const decision = primed.offer(panned, 2_060);
    expect(decision.motion).not.toBeNull();
    expect(decision.motion).toBeGreaterThan(0);
  });

  test("measures motion against the primed frame, not the last offered one", () => {
    const first = scene({ seed: 7 });
    const second = scene({ seed: 12 });

    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(first, 100);
    // Primed with the frame the next offer is identical to. Measured against
    // the offer before it instead, this would be a large number.
    gate.observe(second, 200);
    expect(gate.offer(second, 220).motion).toBe(0);
  });

  test("never keeps the frame it is given, and does not move the rate floor", () => {
    const view = scene({ seed: 3 });
    const other = scene({ seed: 21 });

    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    // Two frames primed where a keep would otherwise be due. The last one is
    // the view about to be offered, so the settle check passes and what is
    // left to decide the outcome is whether a primer ever counted as a keep.
    gate.observe(view, 100);
    gate.observe(other, 200);
    const decision = gate.offer(other, 220);
    // "first" is the proof: had either primer kept, this would be an ordinary
    // offer inside the rate floor instead.
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("first");
    // And the floor runs from the offer, not from either primed frame.
    expect(gate.offer(other, 250).reason).toBe("rate-floor");
  });

  test("does not become the novelty baseline", () => {
    const kept = scene({ seed: 5 });
    const primed = scene({ seed: 40 });

    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(kept, 0);
    const withoutPrimer = gate.offer(kept, 10_000).novelty;

    const primedGate = createFrameGate(TEST_OPTIONS);
    primedGate.reset(0);
    primedGate.offer(kept, 0);
    primedGate.observe(primed, 9_980);
    // Novelty is scored against the last KEPT frame, which a primed frame
    // never becomes, so the same candidate scores the same either way.
    expect(primedGate.offer(kept, 10_000).novelty).toBe(withoutPrimer!);
  });

  test("does not end warmup", () => {
    const view = scene({ seed: 9 });
    const gate = createFrameGate({ ...TEST_OPTIONS, warmupMs: 500 });
    gate.reset(0);

    gate.observe(view, 100);
    gate.observe(view, 200);
    // Warmup covers the badly exposed frames a camera opens with. A primer is
    // one of those frames too, and passing it must not spend the window.
    expect(gate.offer(view, 300).reason).toBe("warmup");
    expect(gate.offer(scene({ seed: 10 }), 600).keep).toBe(true);
  });

  test("judges the offered frame on its own detail, not the primer's", () => {
    const view = scene({ seed: 11 });
    const flat = flatWall(makeRandom(2));

    // Settle raised out of reach, so the only thing left to reject this frame
    // is the detail check the primer must not have poisoned. A flat primer
    // against a textured frame is otherwise a large motion reading, which is
    // the gate working and would hide what this case is about.
    const gate = createFrameGate({ ...TEST_OPTIONS, settleThreshold: 100 });
    gate.reset(0);
    gate.observe(flat, 100);
    const decision = gate.offer(view, 120);
    expect(decision.detail).toBeGreaterThan(TEST_OPTIONS.minDetail);
    expect(decision.reason).toBe("first");
    expect(decision.keep).toBe(true);
  });

  test("rejects a grid of the wrong size, exactly as an offer does", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    expect(() => gate.observe(new Uint8Array(4), 0)).toThrow();
  });
});

/**
 * The one-shot arm.
 *
 * Everything the gate weighs is about the frames around this one, and none of
 * it can see the moment a user starts asking about what the camera is pointed
 * at. An arm is the caller answering that question for it, so what these check
 * is the shape of the exception: which vetoes it is allowed to skip, which it
 * is not, that it spends itself, and that the frame behind it is judged against
 * it rather than firing again.
 */
describe("frame gate forced keep", () => {
  test("keeps a frame the rate floor would have turned away", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    expect(gate.offer(scene({ seed: 1 }), 0).reason).toBe("first");
    expect(gate.offer(scene({ seed: 1 }), 20).reason).toBe("rate-floor");

    gate.armForcedKeep(30);
    const decision = gate.offer(scene({ seed: 1 }), 40);
    expect(decision.keep).toBe(true);
    expect(decision.reason).toBe("forced");
  });

  test("keeps a moving frame, and one nothing changed in", () => {
    const still = scene({ seed: 4 });
    const panned = scene({ seed: 4, panX: 4 });
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(still, 0);

    // Mid-pan: motion against the frame 20ms before it is over the settle
    // threshold, which is what normally holds a smeared frame back.
    gate.offer(panned, 200);
    gate.armForcedKeep(210);
    const moving = gate.offer(still, 220);
    expect(moving.motion).toBeGreaterThan(TEST_OPTIONS.settleThreshold);
    expect(moving.reason).toBe("forced");

    // The other end of the same exception: a view the gate has already kept
    // and would otherwise call unchanged.
    gate.armForcedKeep(400);
    const same = gate.offer(still, 420);
    expect(same.novelty).toBeLessThan(TEST_OPTIONS.noveltyThreshold);
    expect(same.reason).toBe("forced");
  });

  test("keeps before any baseline exists, in place of the first keep", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);

    gate.armForcedKeep(0);
    const decision = gate.offer(scene({ seed: 1 }), 10);
    expect(decision.reason).toBe("forced");
    expect(decision.novelty).toBeNull();
  });

  test("is spent by the frame it keeps", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);

    gate.armForcedKeep(0);
    expect(gate.offer(scene({ seed: 1 }), 10).reason).toBe("forced");
    // The whole point of a one-shot: a second arm is a second ask, and a
    // second keep off one ask would double every utterance's cost.
    expect(gate.offer(scene({ seed: 2 }), 20).reason).toBe("rate-floor");
  });

  test("re-arms the rate floor, so the next frame does not keep behind it", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(200);
    expect(gate.offer(scene({ seed: 1 }), 210).reason).toBe("forced");
    // Recorded like any other keep, so the floor's clock moved with it. A
    // forced keep that skipped that would fire a second, ambient keep of the
    // same scene on the very next frame.
    expect(gate.offer(scene({ seed: 9 }), 260).reason).toBe("rate-floor");
    // And the novelty baseline moved too: this is the forced frame's own view
    // offered back once the floor has passed.
    expect(gate.offer(scene({ seed: 1 }), 400).reason).toBe("unchanged");
  });

  test("keeps nothing while the camera is still warming up", () => {
    const gate = createFrameGate({ ...TEST_OPTIONS, warmupMs: 600 });
    gate.reset(0);

    gate.armForcedKeep(0);
    // A frame taken before exposure converged answers nobody's question, and
    // keeping one would make it the baseline everything else is scored on.
    expect(gate.offer(scene({ seed: 1 }), 100).reason).toBe("warmup");
    expect(gate.offer(scene({ seed: 1 }), 599).reason).toBe("warmup");
    // The arm outlives the window rather than being spent by it, so the first
    // frame worth keeping is the one the ask lands on.
    expect(gate.offer(scene({ seed: 1 }), 620).reason).toBe("forced");
  });

  test("keeps nothing off a featureless view", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);

    gate.armForcedKeep(0);
    expect(gate.offer(flatWall(makeRandom(3)), 10).reason).toBe("featureless");
    expect(gate.offer(occluded(makeRandom(5)), 20).reason).toBe("featureless");
    // Still armed: the hand comes off the lens and that is the view the ask
    // was about.
    expect(gate.offer(scene({ seed: 1 }), 30).reason).toBe("forced");
  });

  test("expires rather than keeping a scene the ask has outlived", () => {
    // The heartbeat raised out of reach, so what keeps this frame or does not
    // is the arm alone rather than the refresh a long idle would have earned.
    const gate = createFrameGate({ ...TEST_OPTIONS, maxIntervalMs: 60_000 });
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(10);
    const late = gate.offer(
      scene({ seed: 1 }),
      10 + FRAME_GATE_FORCED_KEEP_TTL_MS + 1,
    );
    expect(late.keep).toBe(false);
    expect(late.reason).toBe("unchanged");
  });

  test("a frame on the last millisecond of the window still consumes it", () => {
    const gate = createFrameGate({ ...TEST_OPTIONS, maxIntervalMs: 60_000 });
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(10);
    expect(
      gate.offer(scene({ seed: 1 }), 10 + FRAME_GATE_FORCED_KEEP_TTL_MS).reason,
    ).toBe("forced");
  });

  test("leaves a frame stamped before the ask to the ambient rules", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    // A native pair in flight when speech starts offers a capture stamped
    // before the arm: the pre-question scene, exactly what the arm exists to
    // get past. It is judged like any ambient frame instead.
    gate.armForcedKeep(50);
    expect(gate.offer(scene({ seed: 9 }), 40).reason).toBe("rate-floor");
  });

  test("stands past a pre-ask frame and is spent by the next fresh one", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(50);
    expect(gate.offer(scene({ seed: 9 }), 40).reason).toBe("rate-floor");
    // The follow-up pair, captured after the ask, is the one the arm is for.
    expect(gate.offer(scene({ seed: 9 }), 60).reason).toBe("forced");
  });

  test("a frame stamped at the ask's own moment consumes it", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(50);
    expect(gate.offer(scene({ seed: 1 }), 50).reason).toBe("forced");
  });

  test("a capture begun before the ask cannot spend the arm, however late it lands", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    // A bridge request issued at 40 that answers at 60: the offer's stamp
    // postdates the arm, but the picture cannot be proven to.
    gate.armForcedKeep(50);
    expect(gate.offer(scene({ seed: 9 }), 60, 40).reason).toBe("rate-floor");
    // The arm survives it, for a capture that provably began after the ask.
    expect(gate.offer(scene({ seed: 9 }), 70, 65).reason).toBe("forced");
  });

  test("a capture begun at the ask's own moment consumes it", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(50);
    expect(gate.offer(scene({ seed: 1 }), 60, 50).reason).toBe("forced");
  });

  test("a reset drops an unspent arm", () => {
    const gate = createFrameGate(TEST_OPTIONS);
    gate.reset(0);
    gate.offer(scene({ seed: 1 }), 0);

    gate.armForcedKeep(20);
    // A flip points the camera somewhere else entirely, so the ask was about a
    // scene this gate can no longer be asked for. The floor's clock survives
    // the reset, which is what the next frame is turned away by.
    gate.reset(30);
    expect(gate.offer(scene({ seed: 1 }), 50).reason).toBe("rate-floor");
  });

  test("names a check the readout can place, on both branches", () => {
    const withoutBaseline = createFrameGate(TEST_OPTIONS);
    withoutBaseline.reset(0);
    withoutBaseline.armForcedKeep(0);
    const first = withoutBaseline.offer(scene({ seed: 1 }), 10);

    const withBaseline = createFrameGate(TEST_OPTIONS);
    withBaseline.reset(0);
    withBaseline.offer(scene({ seed: 1 }), 0);
    withBaseline.armForcedKeep(10);
    const later = withBaseline.offer(scene({ seed: 1 }), 20);

    expect(first.novelty).toBeNull();
    expect(later.novelty).not.toBeNull();
    for (const decision of [first, later]) {
      expect(frameGateDecisionPath(decision)).toContain("forced");
    }
  });
});
