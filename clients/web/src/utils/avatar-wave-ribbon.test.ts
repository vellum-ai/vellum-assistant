import { describe, expect, it } from "bun:test";

import {
  buildRibbonWave,
  mulberry32,
  resolveRibbon,
  ribbonSizingHeight,
  type RelativeRibbonPoint,
  type RibbonPoint,
} from "@/utils/avatar-wave-ribbon";

const RIBBON: RibbonPoint[] = [
  { x: 0, y: 0, w: 100, s: 40 },
  { x: 100, y: 200, w: 160, s: 80 },
  { x: 40, y: 400, w: 200, s: 120 },
];

const RELATIVE: RelativeRibbonPoint[] = [
  { fx: 0.25, fy: 0.1, fw: 0.2, fs: 0.02 },
  { fx: 1.2, fy: 0.5, fw: 0.6, fs: 0.06 },
  { fx: 0.5, fy: 1.1, fw: 1.5, fs: 0.12 },
];

describe("mulberry32", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const runA = [a(), a(), a(), a()];
    const runB = [b(), b(), b(), b()];
    expect(runA).toEqual(runB);
  });

  it("produces values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("does not return the same value every call", () => {
    const rng = mulberry32(1);
    const seen = new Set(Array.from({ length: 50 }, () => rng()));
    expect(seen.size).toBeGreaterThan(40);
  });
});

describe("buildRibbonWave", () => {
  it("reproduces the same composition for the same seed", () => {
    expect(buildRibbonWave(RIBBON, 99)).toEqual(buildRibbonWave(RIBBON, 99));
  });

  it("produces a different composition for a different seed", () => {
    expect(buildRibbonWave(RIBBON, 99)).not.toEqual(
      buildRibbonWave(RIBBON, 100),
    );
  });

  it("lays several rows along the ribbon rather than a single one", () => {
    const items = buildRibbonWave(RIBBON, 1);
    expect(items.length).toBeGreaterThan(10);
  });

  it("caps avatar size at maxSize", () => {
    const capped = buildRibbonWave(RIBBON, 1, 50);
    expect(capped.length).toBeGreaterThan(0);
    for (const item of capped) {
      expect(item.size).toBeLessThanOrEqual(50);
    }
  });

  it("grows avatars from the head of the ribbon toward its tail", () => {
    const items = buildRibbonWave(RIBBON, 3);
    const head = items.slice(0, 10);
    const tail = items.slice(-10);
    const mean = (xs: typeof items) =>
      xs.reduce((sum, i) => sum + i.size, 0) / xs.length;
    expect(mean(tail)).toBeGreaterThan(mean(head));
  });

  it("keeps every avatar within a sane distance of the centerline", () => {
    // Nothing should land far outside the widest band (200) plus jitter.
    const items = buildRibbonWave(RIBBON, 5);
    for (const item of items) {
      expect(Math.abs(item.x)).toBeLessThan(400);
      expect(item.y).toBeGreaterThan(-200);
      expect(item.y).toBeLessThan(600);
    }
  });

  it("returns nothing for a ribbon that cannot form a segment", () => {
    expect(buildRibbonWave([], 1)).toEqual([]);
    expect(buildRibbonWave([{ x: 0, y: 0, w: 10, s: 10 }], 1)).toEqual([]);
  });

  it("skips zero-length segments instead of looping forever", () => {
    const degenerate: RibbonPoint[] = [
      { x: 10, y: 10, w: 50, s: 20 },
      { x: 10, y: 10, w: 50, s: 20 },
      { x: 10, y: 90, w: 50, s: 20 },
    ];
    const items = buildRibbonWave(degenerate, 2);
    expect(items.length).toBeGreaterThan(0);
  });
});

describe("resolveRibbon", () => {
  it("measures x against the width and y against the height", () => {
    const resolved = resolveRibbon(RELATIVE, 400, 800);
    const rounded = resolved.map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
      w: Math.round(p.w),
      s: Math.round(p.s),
    }));
    expect(rounded).toEqual([
      { x: 100, y: 80, w: 80, s: 16 },
      { x: 480, y: 400, w: 240, s: 48 },
      { x: 200, y: 880, w: 600, s: 96 },
    ]);
  });

  it("keeps an off-screen point off screen at any aspect ratio", () => {
    // The wrap ribbon's excursion is the one part of the composition that
    // must never come back on screen: it is what makes the thread read as
    // leaving and returning rather than doubling back inside the frame.
    for (const [w, h] of [
      [320, 1000],
      [390, 844],
      [767, 500],
    ]) {
      const resolved = resolveRibbon(RELATIVE, w!, h!);
      expect(resolved[1]!.x).toBeGreaterThan(w!);
    }
  });

  it("spans the box with a ribbon wider than it", () => {
    const [, , tail] = resolveRibbon(RELATIVE, 390, 844);
    expect(tail!.x - tail!.w / 2).toBeLessThan(0);
    expect(tail!.x + tail!.w / 2).toBeGreaterThan(390);
  });

  it("returns an empty ribbon unchanged", () => {
    expect(resolveRibbon([], 390, 844)).toEqual([]);
  });

  it("sizes a wide box's avatars off the held height, not its own", () => {
    const [head] = resolveRibbon(RELATIVE, 800, 400);
    // 800 * 1.3 = 1040, so the avatars are sized as if the box were that
    // tall rather than shrinking to fit 400.
    expect(head!.s).toBeCloseTo(0.02 * 1040, 5);
    // Position is untouched: only the size basis is held.
    expect(head!.y).toBeCloseTo(0.1 * 400, 5);
  });
});

describe("ribbonSizingHeight", () => {
  it("is the box's own height on every portrait phone", () => {
    for (const [w, h] of [
      [320, 568],
      [375, 667],
      [390, 844],
      [430, 932],
    ]) {
      expect(ribbonSizingHeight(w!, h!)).toBe(h!);
    }
  });

  it("holds a box that is wide for its height to its aspect", () => {
    expect(ribbonSizingHeight(667, 375)).toBeCloseTo(667 * 1.3, 5);
    expect(ribbonSizingHeight(767, 600)).toBeCloseTo(767 * 1.3, 5);
  });

  it("keeps the crowd's cost flat across aspect ratios", () => {
    // Avatar count goes as the box's area over its size squared, and every
    // avatar is simulated and drawn on every frame, so a box wide for its
    // height has to scale its avatars up rather than pack in more of them.
    const count = (w: number, h: number) =>
      buildRibbonWave(
        resolveRibbon(RELATIVE, w, h),
        1,
        ribbonSizingHeight(w, h) * 0.135,
      ).length;
    const portrait = count(390, 844);
    for (const [w, h] of [
      [667, 375],
      [767, 400],
      [767, 600],
      [720, 750],
    ]) {
      expect(count(w!, h!)).toBeLessThan(portrait * 4);
    }
  });
});
