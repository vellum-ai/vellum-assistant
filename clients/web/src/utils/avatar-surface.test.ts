/**
 * Tests for the avatar-tinted full-bleed surface helpers (`blendHex`,
 * `avatarSurfaceHex`): the deep ground the takeover paints behind an avatar's
 * accent color, which must stay dark enough for white UI to read on top.
 */

import { describe, expect, test } from "bun:test";

import { BUNDLED_COMPONENTS } from "./avatar-bundled-components";
import { SURFACE_GROUND, avatarSurfaceHex, blendHex } from "./avatar-tone";

/** WCAG relative luminance of a #rrggbb hex. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (shift: number) => {
    const c = ((n >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe("avatarSurfaceHex", () => {
  test("green avatar reproduces the takeover's established surface", () => {
    const derived = channels(avatarSurfaceHex("#4C9B50"));
    const target = channels("#1D271E");
    for (const [i, c] of derived.entries()) {
      expect(Math.abs(c - target[i]!)).toBeLessThanOrEqual(1);
    }
  });

  test("every bundled palette color clears 7:1 against white", () => {
    for (const { hex } of BUNDLED_COMPONENTS.colors) {
      expect(contrastRatio(avatarSurfaceHex(hex), "#FFFFFF")).toBeGreaterThanOrEqual(7);
    }
  });

  test("malformed accents degrade to the ground", () => {
    for (const bad of ["rebeccapurple", "#GGG", ""]) {
      expect(avatarSurfaceHex(bad)).toBe(SURFACE_GROUND);
    }
  });
});

describe("blendHex", () => {
  test("alpha 0 is the base, alpha 1 is the overlay", () => {
    expect(blendHex("#151515", "#4C9B50", 0).toLowerCase()).toBe("#151515");
    expect(blendHex("#151515", "#4C9B50", 1).toLowerCase()).toBe("#4c9b50");
  });

  test("alpha is clamped and malformed inputs return the base", () => {
    expect(blendHex("#151515", "#4C9B50", -1).toLowerCase()).toBe("#151515");
    expect(blendHex("#151515", "#4C9B50", 2).toLowerCase()).toBe("#4c9b50");
    expect(blendHex("#151515", "nope", 0.5)).toBe("#151515");
  });
});
