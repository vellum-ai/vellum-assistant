/**
 * Tests for the eye-art bounding boxes.
 *
 * The two functions answer different questions and both answers are load
 * bearing, so the cases below are mostly the same path measured twice:
 * `pathBBox` reports the box the control polygon reaches (what the peeking and
 * voice-room eyes have always framed against, pinned here so it cannot drift),
 * and `tightPathBBox` reports the box the ink reaches (what has to agree with
 * an independently rasterized copy of the same artwork).
 */

import { describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { pathBBox, tightPathBBox, unionBBox } from "@/utils/eye-bbox";

/** A symmetric hump: control points at y=100, the curve peaks at y=75. */
const HUMP = "M0 0C0 100 100 100 100 0Z";

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

  test("drops the control-point overshoot the `angry` style carries", () => {
    const angry = BUNDLED_COMPONENTS.eyeStyles.find(
      (eyeStyle) => eyeStyle.id === "angry",
    );
    if (!angry) {
      throw new Error("The bundled catalog lost the angry eye style");
    }
    const tight = unionBBox(
      angry.paths.map((path) => tightPathBBox(path.svgPath)),
    );
    const control = unionBBox(
      angry.paths.map((path) => pathBBox(path.svgPath)),
    );
    expect(tight.w).toBeCloseTo(control.w, 6);
    // Its sclera curve is drawn with control points well below the ink.
    expect(control.h / tight.h).toBeGreaterThan(1.5);
  });
});
