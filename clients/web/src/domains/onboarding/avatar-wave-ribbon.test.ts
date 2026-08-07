import { describe, expect, it } from "bun:test";

import {
  buildRibbonWave,
  mulberry32,
  type RibbonPoint,
} from "@/domains/onboarding/avatar-wave-ribbon";

const RIBBON: RibbonPoint[] = [
  { x: 0, y: 0, w: 100, s: 40 },
  { x: 100, y: 200, w: 160, s: 80 },
  { x: 40, y: 400, w: 200, s: 120 },
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
