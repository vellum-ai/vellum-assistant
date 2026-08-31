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
  FRAME_GRID_CELLS,
  FRAME_GRID_SIZE,
  type FrameGateOptions,
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
function scene({
  seed,
  panX = 0,
}: {
  seed: number;
  panX?: number;
}): FrameGrid {
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
    expect(noveltyBetween(base, darker)).toBeLessThan(
      NUISANCE_CEILING,
    );
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
      if (decision.keep && (decision.motion ?? 0) >= TEST_OPTIONS.settleThreshold) {
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
      const decision = gate.offer(
        scene({ seed: 9, panX: step * 0.25 }),
        time,
      );
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
