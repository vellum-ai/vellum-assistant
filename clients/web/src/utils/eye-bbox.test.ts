/**
 * Tests for the eye-art bounding boxes.
 *
 * The two functions answer different questions and both answers are load
 * bearing, so the cases below are mostly the same path measured twice:
 * `pathBBox` reports the box the control polygon reaches (what the peeking and
 * voice-room eyes intentionally frame against, pinned here so it cannot drift),
 * and `tightPathBBox` reports the box the ink reaches (what has to agree with
 * an independently rasterized copy of the same artwork).
 *
 * The bundled-art cases check `tightPathBBox` against {@link SAMPLED_BOUNDS},
 * numbers produced by a different method, so the parser is measured rather
 * than merely held to its own output. The synthetic cases use paths whose
 * answer is known analytically.
 */

import { describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  pathBBox,
  tightPathBBox,
  unionBBox,
  type BBox,
} from "@/utils/eye-bbox";

/** A symmetric hump: control points at y=100, the curve peaks at y=75. */
const HUMP = "M0 0C0 100 100 100 100 0Z";

/**
 * Ground truth for two bundled eye styles, in path units, measured by walking
 * every curve at 40,000 points and keeping the extremes. `angry` is the style
 * whose control points sit furthest from its ink and `grumpy` the one style
 * that uses `H`, so between them they cover both things this parser has to get
 * right. Regenerate rather than adjust if the bundled art changes.
 */
const SAMPLED_BOUNDS = {
  angry: { x: 151, y: 267, w: 397.822, h: 130.949 },
  grumpy: { x: 90.5841, y: 226.908, w: 417.6578, h: 91.859 },
} as const;

/** Slack for the sampled numbers above, in path units. */
const SAMPLING_TOLERANCE = 1e-3;

function unionOf(eyeStyleId: string, measure: (d: string) => BBox): BBox {
  const eyeStyle = BUNDLED_COMPONENTS.eyeStyles.find(
    (candidate) => candidate.id === eyeStyleId,
  );
  if (!eyeStyle) {
    throw new Error(`The bundled catalog lost the ${eyeStyleId} eye style`);
  }
  return unionBBox(eyeStyle.paths.map((path) => measure(path.svgPath)));
}

describe("pathBBox", () => {
  test("extends by control points", () => {
    expect(pathBBox(HUMP)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe("tightPathBBox", () => {
  test("solves a cubic for the extent it actually draws", () => {
    const box = tightPathBBox(HUMP);
    expect(box.x).toBeCloseTo(0, 9);
    expect(box.y).toBeCloseTo(0, 9);
    expect(box.w).toBeCloseTo(100, 9);
    expect(box.h).toBeCloseTo(75, 9);
  });

  test("agrees with the control-point box on straight segments", () => {
    const polyline = "M10 20L60 20L60 90Z";
    expect(tightPathBBox(polyline)).toEqual(pathBBox(polyline));
  });

  test("tracks the current point through `H` and `V`", () => {
    // `grumpy` is the one bundled style that uses `H`.
    const withH = "M10 40H70V90Z";
    expect(tightPathBBox(withH)).toEqual({ x: 10, y: 40, w: 60, h: 50 });
  });

  test("returns an empty box for a path with no geometry", () => {
    expect(tightPathBBox("")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  test("is never larger than the control-point box for bundled eye art", () => {
    for (const eyeStyle of BUNDLED_COMPONENTS.eyeStyles) {
      const tight = unionBBox(
        eyeStyle.paths.map((path) => tightPathBBox(path.svgPath)),
      );
      const control = unionBBox(
        eyeStyle.paths.map((path) => pathBBox(path.svgPath)),
      );
      expect(tight.w).toBeLessThanOrEqual(control.w + 1e-9);
      expect(tight.h).toBeLessThanOrEqual(control.h + 1e-9);
      expect(tight.x).toBeGreaterThanOrEqual(control.x - 1e-9);
      expect(tight.y).toBeGreaterThanOrEqual(control.y - 1e-9);
      expect(tight.w).toBeGreaterThan(0);
      expect(tight.h).toBeGreaterThan(0);
    }
  });

  test("matches densely sampled ground truth for bundled eye art", () => {
    for (const [eyeStyleId, expected] of Object.entries(SAMPLED_BOUNDS)) {
      const tight = unionOf(eyeStyleId, tightPathBBox);
      expect(Math.abs(tight.x - expected.x)).toBeLessThanOrEqual(
        SAMPLING_TOLERANCE,
      );
      expect(Math.abs(tight.y - expected.y)).toBeLessThanOrEqual(
        SAMPLING_TOLERANCE,
      );
      expect(Math.abs(tight.w - expected.w)).toBeLessThanOrEqual(
        SAMPLING_TOLERANCE,
      );
      expect(Math.abs(tight.h - expected.h)).toBeLessThanOrEqual(
        SAMPLING_TOLERANCE,
      );
    }
  });

  test("drops the control-point overshoot the `angry` style carries", () => {
    const tight = unionOf("angry", tightPathBBox);
    const control = unionOf("angry", pathBBox);
    expect(tight.w).toBeCloseTo(control.w, 6);
    // Its sclera curve is drawn with control points well below the ink, so the
    // control-point box is the one that disagrees with the sampled truth.
    expect(control.h / tight.h).toBeGreaterThan(1.5);
    expect(Math.abs(control.h - SAMPLED_BOUNDS.angry.h)).toBeGreaterThan(1);
  });
});
