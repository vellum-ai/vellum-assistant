import { describe, expect, it } from "bun:test";

import {
  generateTicks,
  linearScale,
  niceMax,
  niceStep,
  niceStepDigits,
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

describe("niceStep", () => {
  it("rounds up to the nearest nice value (1, 2, 2.5, 5, 10 × 10^n)", () => {
    expect(niceStep(0.3)).toBe(0.5);
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(2.1)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(14)).toBe(20);
    expect(niceStep(70)).toBe(100);
  });

  it("returns 1 for zero or negative input", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
  });

  it("handles sub-cent step sizes", () => {
    expect(niceStep(0.0016)).toBe(0.002);
    expect(niceStep(0.003)).toBe(0.005);
    expect(niceStep(0.008)).toBe(0.01);
  });
});

describe("niceStepDigits", () => {
  it("returns 0 for integer steps >= 1", () => {
    expect(niceStepDigits(1)).toBe(0);
    expect(niceStepDigits(2)).toBe(0);
    expect(niceStepDigits(5)).toBe(0);
    expect(niceStepDigits(10)).toBe(0);
    expect(niceStepDigits(50)).toBe(0);
  });

  it("returns 1 for 2.5× steps >= 1", () => {
    expect(niceStepDigits(2.5)).toBe(1);
    expect(niceStepDigits(25)).toBe(0);
  });

  it("returns correct digits for sub-dollar steps", () => {
    expect(niceStepDigits(0.5)).toBe(1);
    expect(niceStepDigits(0.2)).toBe(1);
    expect(niceStepDigits(0.1)).toBe(1);
    expect(niceStepDigits(0.05)).toBe(2);
    expect(niceStepDigits(0.02)).toBe(2);
    expect(niceStepDigits(0.01)).toBe(2);
    expect(niceStepDigits(0.005)).toBe(3);
    expect(niceStepDigits(0.002)).toBe(3);
  });

  it("adds extra digit for 2.5× sub-dollar steps", () => {
    expect(niceStepDigits(0.25)).toBe(2);
    expect(niceStepDigits(0.025)).toBe(3);
    expect(niceStepDigits(0.0025)).toBe(4);
  });
});

describe("niceMax", () => {
  it("returns 1 for all-zero values (continuous)", () => {
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  it("produces a ceiling where yMax / tickCount is a nice number", () => {
    // raw=73 → step≈14.6 → niceStep=20 → yMax=100
    expect(niceMax([73])).toBe(100);
    // raw=350 → step≈70 → niceStep=100 → yMax=500
    expect(niceMax([350])).toBe(500);
    // raw=0.07 → step≈0.014 → niceStep=0.02 → yMax=0.1
    expect(niceMax([0.07])).toBeCloseTo(0.1, 10);
  });

  it("handles exact nice boundaries", () => {
    expect(niceMax([100])).toBe(100);
    expect(niceMax([50])).toBe(50);
    expect(niceMax([10])).toBe(10);
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

  it("guarantees every tick label matches its gridline position", () => {
    const testRawValues = [0.001, 0.008, 0.011, 0.07, 0.15, 0.5, 0.73, 0.9, 1.5, 7.3, 11, 73, 350];
    for (const raw of testRawValues) {
      const yMax = niceMax([raw]);
      const step = yMax / 5;
      const ticks = generateTicks(yMax, 5);

      // Step should be a nice number (1, 2, 2.5, or 5 × 10^n)
      const magnitude = 10 ** Math.floor(Math.log10(step));
      const normalized = step / magnitude;
      const isNice = [1, 2, 2.5, 5, 10].some((n) => Math.abs(normalized - n) < 1e-9);
      expect(isNice).toBe(true);

      // Use the same formatter as the component: niceStepDigits + min 2 for sub-dollar
      const digits = Math.max(step < 1 ? 2 : 0, niceStepDigits(step));
      const labels = ticks.map((t) =>
        t === 0
          ? "$0"
          : `$${t.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`,
      );

      // No duplicate labels
      const uniqueLabels = new Set(labels);
      expect(uniqueLabels.size).toBe(labels.length);

      // Parsed labels match tick values exactly
      for (let i = 1; i < ticks.length; i++) {
        const parsed = parseFloat(labels[i]!.replace("$", "").replace(/,/g, ""));
        expect(Math.abs(parsed - ticks[i]!)).toBeLessThan(1e-9);
      }
    }
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

  it("rounds ticks to avoid floating-point drift", () => {
    // 0.2 × 3 = 0.6000000000000001 in raw JS — must be cleaned up
    const ticks = generateTicks(1.0, 5);
    expect(ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1.0]);
    for (const t of ticks) {
      expect(t).toBe(parseFloat(t.toFixed(10)));
    }
  });

  it("handles sub-cent tick generation", () => {
    const ticks = generateTicks(0.01, 5);
    expect(ticks).toEqual([0, 0.002, 0.004, 0.006, 0.008, 0.01]);
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
