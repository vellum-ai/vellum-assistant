import { describe, expect, test } from "bun:test";

import {
  applyAlphaMask,
  circleCoverage,
  compositeCentered,
  roundedRectCoverage,
} from "./image-mask";

// A solid opaque white BGRA bitmap, so masking changes show up purely in alpha.
const opaqueBitmap = (sizePx: number): Buffer => {
  const buf = Buffer.alloc(sizePx * sizePx * 4);
  buf.fill(255);
  return buf;
};

const alphaAt = (bitmap: Buffer, sizePx: number, x: number, y: number): number =>
  bitmap[(y * sizePx + x) * 4 + 3]!;

describe("circleCoverage", () => {
  const SIZE = 36;
  const coverage = circleCoverage(SIZE);

  test("is fully inside at the center and fully outside at the corners", () => {
    expect(coverage(SIZE / 2, SIZE / 2)).toBe(1);
    expect(coverage(0, 0)).toBe(0);
    expect(coverage(SIZE - 1, SIZE - 1)).toBe(0);
  });

  test("ramps through a fractional value across the one-pixel edge", () => {
    // A pixel straddling the circle's right edge (center row, x≈size) gets
    // partial coverage rather than a hard 0/1 step.
    const edge = coverage(SIZE - 1, SIZE / 2 - 1);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });
});

describe("roundedRectCoverage", () => {
  const SIZE = 100;
  const RADIUS = 23; // 0.23 × size, matching the native Dock squircle.
  const coverage = roundedRectCoverage(SIZE, RADIUS);

  test("fills the interior and the straight edges", () => {
    expect(coverage(SIZE / 2, SIZE / 2)).toBe(1);
    // Mid-edge points (well away from the corners) are inside the rect.
    expect(coverage(SIZE / 2, 1)).toBe(1);
    expect(coverage(1, SIZE / 2)).toBe(1);
  });

  test("clips the corners outside the rounded radius", () => {
    // The very corner pixel lies outside the rounded corner arc.
    expect(coverage(0, 0)).toBe(0);
    expect(coverage(SIZE - 1, 0)).toBe(0);
  });

  test("degrades to a circle when the radius exceeds half the canvas", () => {
    const circle = circleCoverage(SIZE);
    const huge = roundedRectCoverage(SIZE, SIZE);
    // With radius clamped to half, the rounded rect is exactly the inscribed
    // circle: corners clipped, center filled.
    expect(huge(SIZE / 2, SIZE / 2)).toBe(circle(SIZE / 2, SIZE / 2));
    expect(huge(0, 0)).toBe(circle(0, 0));
  });
});

describe("applyAlphaMask", () => {
  const SIZE = 36;

  test("keeps interior alpha, zeroes exterior alpha, and preserves color", () => {
    const bitmap = opaqueBitmap(SIZE);
    applyAlphaMask(bitmap, SIZE, circleCoverage(SIZE));

    // Center stays fully opaque; corner is clipped to transparent.
    expect(alphaAt(bitmap, SIZE, SIZE / 2, SIZE / 2)).toBe(255);
    expect(alphaAt(bitmap, SIZE, 0, 0)).toBe(0);

    // Color channels (BGR) are untouched — only alpha is scaled.
    const centerOffset = (SIZE / 2 * SIZE + SIZE / 2) * 4;
    expect(bitmap[centerOffset]).toBe(255);
    expect(bitmap[centerOffset + 1]).toBe(255);
    expect(bitmap[centerOffset + 2]).toBe(255);
  });

  test("returns the same buffer it mutated", () => {
    const bitmap = opaqueBitmap(SIZE);
    expect(applyAlphaMask(bitmap, SIZE, circleCoverage(SIZE))).toBe(bitmap);
  });
});

describe("compositeCentered", () => {
  test("insets the source into the center of a larger transparent canvas", () => {
    const SRC = 2;
    const DEST = 4;
    const src = Buffer.alloc(SRC * SRC * 4);
    src.fill(255); // fully opaque source

    const dest = compositeCentered(src, SRC, DEST);
    expect(dest.length).toBe(DEST * DEST * 4);

    // The 2×2 source lands centered at the inner 2×2 block (offset 1,1).
    expect(alphaAt(dest, DEST, 1, 1)).toBe(255);
    expect(alphaAt(dest, DEST, 2, 2)).toBe(255);
    // The padding border stays transparent.
    expect(alphaAt(dest, DEST, 0, 0)).toBe(0);
    expect(alphaAt(dest, DEST, 3, 3)).toBe(0);
  });
});
