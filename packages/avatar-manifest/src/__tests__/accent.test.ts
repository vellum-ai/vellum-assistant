import { describe, expect, test } from "bun:test";

import {
  dominantAccentHex,
  isAvatarAccentHex,
  normalizeAvatarAccentHex,
} from "../accent.js";

/** An RGBA block from `[r, g, b, a, count]` runs. */
function pixels(...runs: [number, number, number, number, number][]) {
  const out: number[] = [];
  for (const [r, g, b, a, count] of runs) {
    for (let i = 0; i < count; i += 1) {
      out.push(r, g, b, a);
    }
  }
  return new Uint8ClampedArray(out);
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function saturation(hex: string): number {
  const ch = channels(hex).map((c) => c / 255);
  const max = Math.max(...ch);
  const min = Math.min(...ch);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

describe("isAvatarAccentHex / normalizeAvatarAccentHex", () => {
  test("accepts #rrggbb in either case and canonicalizes to lowercase", () => {
    expect(isAvatarAccentHex("#E9642F")).toBe(true);
    expect(normalizeAvatarAccentHex("  #E9642F ")).toBe("#e9642f");
  });

  test.each([
    ["short form", "#abc"],
    ["no hash", "e9642f"],
    ["alpha channel", "#e9642fff"],
    ["not a string", 0xe9642f],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(isAvatarAccentHex(value)).toBe(false);
    expect(normalizeAvatarAccentHex(value)).toBeNull();
  });
});

describe("dominantAccentHex", () => {
  test("picks the coloured mark over the white ground it sits on", () => {
    // Nine in ten pixels are white; the accent is still the red.
    const hex = dominantAccentHex(
      pixels([255, 255, 255, 255, 90], [200, 30, 30, 255, 10]),
    );
    expect(hex).toBe("#c81e1e");
  });

  test("picks the coloured mark over a black ground", () => {
    expect(
      dominantAccentHex(pixels([0, 0, 0, 255, 90], [40, 120, 200, 255, 10])),
    ).toBe("#2878c8");
  });

  test("prefers the more prevalent of two accents", () => {
    expect(
      dominantAccentHex(
        pixels([200, 30, 30, 255, 30], [40, 120, 200, 255, 50]),
      ),
    ).toBe("#2878c8");
  });

  test("averages a gradient of one hue rather than splitting it", () => {
    // Three reds close together are one bin; a lone saturated blue is not
    // more prevalent than the three of them together.
    const hex = dominantAccentHex(
      pixels(
        [200, 30, 30, 255, 10],
        [210, 40, 35, 255, 10],
        [190, 25, 28, 255, 10],
        [40, 120, 200, 255, 12],
      ),
    );
    const [r, , b] = channels(hex!);
    expect(r).toBeGreaterThan(b);
  });

  test("keeps a gray image gray instead of inventing a hue", () => {
    const hex = dominantAccentHex(
      pixels([120, 120, 120, 255, 80], [122, 121, 119, 255, 20]),
    );
    expect(saturation(hex!)).toBeLessThan(0.05);
  });

  test("a stray colourful pixel does not outrank a gray image", () => {
    const hex = dominantAccentHex(
      pixels([128, 128, 128, 255, 98], [255, 0, 0, 255, 2]),
    );
    expect(saturation(hex!)).toBeLessThan(0.05);
  });

  test("skips transparent pixels: a cutout's ground is not its colour", () => {
    const cutout = dominantAccentHex(
      pixels([0, 0, 0, 0, 90], [40, 120, 200, 255, 10]),
    );
    expect(cutout).toBe(dominantAccentHex(pixels([40, 120, 200, 255, 10])));
  });

  test("returns null when nothing is opaque enough to count", () => {
    expect(dominantAccentHex(pixels([12, 34, 56, 0, 40]))).toBeNull();
    expect(dominantAccentHex(new Uint8ClampedArray())).toBeNull();
  });

  test("returns a canonical lowercase #rrggbb", () => {
    expect(dominantAccentHex(pixels([233, 100, 47, 255, 4]))).toBe("#e9642f");
  });
});
