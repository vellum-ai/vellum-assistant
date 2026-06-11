import { describe, expect, it } from "bun:test";

import {
  generateTicks,
  linearScale,
  niceMax,
  pickXTickIndices,
  topRoundedRect,
} from "./chart-scale-utils";

describe("linearScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const scale = linearScale([0, 100], [0, 500]);
    expect(scale(0)).toBe(0);
    expect(scale(100)).toBe(500);
  });

  it("interpolates mid-domain values", () => {
    const scale = linearScale([0, 100], [0, 500]);
    expect(scale(50)).toBe(250);
  });

  it("handles inverted range (SVG y-axis, top=0)", () => {
    const scale = linearScale([0, 100], [300, 0]);
    expect(scale(0)).toBe(300);
    expect(scale(100)).toBe(0);
    expect(scale(50)).toBe(150);
  });

  it("returns range start when domain span is zero", () => {
    const scale = linearScale([0, 0], [0, 300]);
    expect(scale(0)).toBe(0);
  });
});

describe("niceMax", () => {
  it("returns 1 for all-zero values (continuous)", () => {
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  it("rounds up to nearest magnitude", () => {
    expect(niceMax([73])).toBe(80);
    expect(niceMax([350])).toBe(400);
    expect(niceMax([0.07])).toBeCloseTo(0.08, 4);
  });

  it("handles single-element arrays", () => {
    expect(niceMax([100])).toBe(100);
  });

  it("returns tickCount for all-zero integer mode", () => {
    expect(niceMax([0], { integerOnly: true, tickCount: 5 })).toBe(5);
  });

  it("produces integer divisible by tickCount for discrete metrics", () => {
    const result = niceMax([8], { integerOnly: true, tickCount: 5 });
    expect(result % 5).toBe(0);
    expect(result).toBeGreaterThanOrEqual(8);
    expect(result).toBe(10);
  });

  it("integer mode handles exact multiples", () => {
    expect(niceMax([15], { integerOnly: true, tickCount: 5 })).toBe(15);
  });

  it("integer mode handles small counts", () => {
    const result = niceMax([3], { integerOnly: true, tickCount: 5 });
    expect(result).toBe(5);
    expect(result % 5).toBe(0);
  });
});

describe("generateTicks", () => {
  it("returns [0] when max is 0", () => {
    expect(generateTicks(0, 5)).toEqual([0]);
  });

  it("produces count+1 ticks from 0 to max", () => {
    const ticks = generateTicks(100, 5);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("produces integer ticks when max is divisible by count", () => {
    const ticks = generateTicks(10, 5);
    expect(ticks).toEqual([0, 2, 4, 6, 8, 10]);
    for (const t of ticks) {
      expect(Number.isInteger(t)).toBe(true);
    }
  });
});

describe("topRoundedRect", () => {
  it("produces a closed SVG path", () => {
    const path = topRoundedRect(10, 20, 40, 60, 3);
    expect(path).toMatch(/^M/);
    expect(path).toMatch(/Z$/);
  });

  it("clamps radius to half the width", () => {
    const path = topRoundedRect(0, 0, 4, 100, 10);
    expect(path).toContain("A2,2");
  });

  it("clamps radius to half the height", () => {
    const path = topRoundedRect(0, 0, 100, 4, 10);
    expect(path).toContain("A2,2");
  });

  it("handles zero-size rect", () => {
    const path = topRoundedRect(0, 0, 0, 0, 3);
    expect(path).toContain("A0,0");
  });
});

describe("pickXTickIndices", () => {
  it("returns empty for zero items", () => {
    expect(pickXTickIndices(0, false)).toEqual([]);
  });

  it("returns all indices for small mobile set", () => {
    expect(pickXTickIndices(3, true)).toEqual([0, 1, 2]);
  });

  it("returns start, middle, end for mobile with many items", () => {
    expect(pickXTickIndices(14, true)).toEqual([0, 7, 13]);
  });

  it("always includes last index on desktop", () => {
    const indices = pickXTickIndices(14, false);
    expect(indices[indices.length - 1]).toBe(13);
    expect(indices[0]).toBe(0);
  });

  it("limits to 12 ticks on desktop", () => {
    const indices = pickXTickIndices(30, false);
    expect(indices.length).toBeLessThanOrEqual(13);
  });
});
