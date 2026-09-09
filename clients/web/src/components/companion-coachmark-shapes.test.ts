/**
 * What a mark may not do, whatever hand it is drawn in.
 *
 * The shapes are judged by eye in the lab, and these are the things an eye
 * cannot check: that the loop never lands on the thing it encloses at any
 * size or setting, and that the same anchor is drawn the same way twice.
 */

import { describe, expect, test } from "bun:test";

import { seedFor } from "./companion-coachmark-path";
import {
  arrowPath,
  CORNER_CLEARANCE,
  enclosureOutline,
  enclosurePath,
  HAND_ARROW,
  HAND_ENCLOSURE,
  HAND_MAX,
} from "./companion-coachmark-shapes";

/** How far `point` is outside `box`, negative when it has landed on it. */
function clearance(
  point: { x: number; y: number },
  box: { width: number; height: number },
): number {
  const beyond = {
    x: Math.max(-point.x, point.x - box.width, 0),
    y: Math.max(-point.y, point.y - box.height, 0),
  };
  if (beyond.x > 0 || beyond.y > 0) {
    return Math.hypot(beyond.x, beyond.y);
  }
  return -Math.min(point.x, box.width - point.x, point.y, box.height - point.y);
}

/**
 * The shapes a region arrives in. The wide panel and the tall rail are the
 * ones that matter: an ellipse through the midpoints of a rectangle's sides
 * passes inside its corners, so those are where a loop cuts across the thing
 * it is supposed to be around.
 */
const BOXES = [
  { width: 34, height: 30, name: "a control" },
  { width: 100, height: 100, name: "a square" },
  { width: 400, height: 60, name: "a wide panel" },
  { width: 40, height: 300, name: "a tall rail" },
  { width: 1, height: 1, name: "a region the size of a point" },
];

const PADDING = 10;

describe("the loop stays off what it encloses", () => {
  for (const box of BOXES) {
    test(`around ${box.name}`, () => {
      let nearest = Infinity;
      for (let anchor = 0; anchor < 120; anchor += 1) {
        for (const strength of [0, HAND_ENCLOSURE, HAND_MAX]) {
          const points = enclosureOutline(box, {
            strength,
            seed: seedFor(anchor / 37, anchor / 53),
            padding: PADDING,
          });
          for (const point of points) {
            nearest = Math.min(nearest, clearance(point, box));
          }
        }
      }
      // The line runs `padding` off the edges and turns the corners closer
      // than that, but never nearer than the corner's share of it. Half the
      // stroke drawn on the line hangs inside, which is what the margin is
      // for.
      expect(nearest).toBeGreaterThanOrEqual(PADDING * CORNER_CLEARANCE - 0.5);
    });
  }

  /**
   * The hand only ever pushes outward, so a stronger one cannot bring the
   * line back onto the thing however far it wanders.
   */
  test("a heavier hand only ever moves the line further out", () => {
    const box = { width: 120, height: 80 };
    const seed = seedFor(0.42, 0.42);
    const near = enclosureOutline(box, { strength: 0, seed, padding: PADDING });
    const far = enclosureOutline(box, {
      strength: HAND_MAX,
      seed,
      padding: PADDING,
    });
    const centre = { x: box.width / 2, y: box.height / 2 };
    const reach = (p: { x: number; y: number }) =>
      Math.hypot(p.x - centre.x, p.y - centre.y);
    near.forEach((point, i) => {
      expect(reach(far[i] as { x: number; y: number })).toBeGreaterThanOrEqual(
        reach(point) - 0.001,
      );
    });
  });
});

/**
 * A control pointed at twice in one conversation has to be marked the same
 * way both times, or the second mark reads as a new instruction.
 */
describe("the same anchor draws the same mark", () => {
  test("the loop is the same path", () => {
    const box = { width: 60, height: 40 };
    const of = () =>
      enclosurePath(box, {
        strength: HAND_ENCLOSURE,
        seed: seedFor(0.31, 0.62),
        padding: PADDING,
      });
    expect(of()).toBe(of());
  });

  test("the arrow is the same path", () => {
    const of = () =>
      arrowPath({
        length: 52,
        approach: "below",
        strength: HAND_ARROW,
        seed: seedFor(0.31, 0.62),
      });
    expect(of()).toEqual(of());
  });

  test("two anchors do not draw the same path", () => {
    const box = { width: 60, height: 40 };
    const of = (x: number) =>
      enclosurePath(box, {
        strength: HAND_ENCLOSURE,
        seed: seedFor(x, 0.62),
        padding: PADDING,
      });
    expect(of(0.31)).not.toBe(of(0.52));
  });
});

/**
 * The arrow stops short of the point rather than landing on it, for the
 * reason the loop sits outside its bounds.
 */
describe("the arrow keeps clear of its point", () => {
  test("the tip stops short by the gap it is given", () => {
    const arrow = arrowPath({
      length: 52,
      approach: "below",
      strength: HAND_ARROW,
      seed: seedFor(0.2, 0.3),
      gap: 10,
    });
    // Drawn pointing up, so the tip is the smallest y in the head.
    const ys = [...arrow.head.matchAll(/-?\d+(?:\.\d+)?\s+(-?\d+(?:\.\d+)?)/g)]
      .map((match) => Number(match[1]))
      .filter((y) => !Number.isNaN(y));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
    expect(arrow.height).toBe(62);
  });
});
