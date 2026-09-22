import { describe, expect, test } from "bun:test";

import {
  buildStreamPath,
  seatRows,
  wrapDistance,
  type StreamPoint,
} from "./upgrade-stream-path";

const POINTS: StreamPoint[] = [
  { fx: 0.2, fy: -0.1, fs: 0.01 },
  { fx: 0.5, fy: 0.2, fs: 0.02 },
  { fx: 0.8, fy: 0.5, fs: 0.04 },
  { fx: 0.5, fy: 0.8, fs: 0.08 },
  { fx: 0.2, fy: 1.1, fs: 0.12 },
];

describe("buildStreamPath", () => {
  test("starts at the first point and ends at the last, with a positive length", () => {
    const path = buildStreamPath(POINTS, 1000, 1000);
    expect(path.length).toBeGreaterThan(1000);
    const head = path.at(0);
    expect(head.x).toBeCloseTo(200, 5);
    expect(head.y).toBeCloseTo(-100, 5);
    expect(head.size).toBeCloseTo(10, 5);
    const tail = path.at(path.length);
    expect(tail.x).toBeCloseTo(200, 5);
    expect(tail.y).toBeCloseTo(1100, 5);
    expect(tail.size).toBeCloseTo(120, 5);
  });

  test("size only grows along a ramp that only grows, and the tangent is unit", () => {
    const path = buildStreamPath(POINTS, 800, 900);
    let last = -Infinity;
    for (let d = 0; d <= path.length; d += path.length / 50) {
      const sample = path.at(d);
      expect(sample.size).toBeGreaterThanOrEqual(last - 1e-9);
      last = sample.size;
      expect(Math.hypot(sample.tx, sample.ty)).toBeCloseTo(1, 6);
    }
  });

  test("turns the tangent gradually, so a lateral seat never steps sideways", () => {
    const path = buildStreamPath(POINTS, 1440, 900);
    const turn = (from: number, to: number) => {
      const a = path.at(from);
      const b = path.at(to);
      return Math.hypot(b.tx - a.tx, b.ty - a.ty);
    };
    // The turn over one pixel never spikes past the turn the surrounding
    // stretch averages per pixel: bends are allowed, corners are not.
    for (let d = 20; d < path.length - 20; d += 1) {
      const local = turn(d - 1, d);
      const around = turn(d - 20, d + 20) / 40;
      expect(local).toBeLessThan(around * 2.5 + 0.0015);
    }
  });

  test("clamps distances past either end", () => {
    const path = buildStreamPath(POINTS, 500, 500);
    expect(path.at(-50)).toEqual(path.at(0));
    expect(path.at(path.length + 50)).toEqual(path.at(path.length));
  });
});

describe("wrapDistance", () => {
  test("loops a distance onto the path from either end", () => {
    expect(wrapDistance(120, 100)).toBe(20);
    expect(wrapDistance(-20, 100)).toBe(80);
    expect(wrapDistance(50, 100)).toBe(50);
    expect(wrapDistance(50, 0)).toBe(0);
  });
});

describe("seatRows", () => {
  test("spaces rows by the local size, so they open out toward the tail", () => {
    const path = buildStreamPath(POINTS, 1000, 1000);
    const rows = seatRows(path, 0.85);
    expect(rows[0]).toBe(0);
    const gaps = rows.slice(1).map((d, i) => d - rows[i]!);
    expect(gaps[0]!).toBeLessThan(gaps[gaps.length - 1]!);
    expect(rows[rows.length - 1]!).toBeLessThan(path.length);
  });
});
