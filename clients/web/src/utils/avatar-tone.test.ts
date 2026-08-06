/**
 * Tests for `toneForBg`'s user-bubble surface tokens (`bubbleBg`/`bubbleFg`).
 *
 * Pins the contract that the bubble is a soft translucent raised lift — a
 * subtle white wash over dark/saturated avatars, a subtle dark wash over the
 * one light avatar color (yellow) — whose text is chosen for WCAG-AA contrast
 * against the *blended* bubble pixel (white over dark avatars, near-black over
 * lighter/mid-tone ones), while the base tone fields (`fg`/`fgMuted`) keep their
 * established values.
 */

import { describe, expect, test } from "bun:test";

import { toneForBg } from "./avatar-tone";

/** WCAG relative luminance of a #rrggbb hex, mirroring avatar-tone internals. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (shift: number) => {
    const c = ((n >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

/** Composite a solid base under a white(255)/black(0) overlay at `alpha`. */
function composite(base: string, overlay: 0 | 255, alpha: number): string {
  const n = parseInt(base.replace("#", ""), 16);
  const mix = (shift: number) =>
    Math.round(((n >> shift) & 0xff) * (1 - alpha) + overlay * alpha);
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("toneForBg bubble tokens", () => {
  test("dark avatar → soft white lift, white text (dark blended surface)", () => {
    const surface = toneForBg("#17191C");
    expect(surface.bubbleBg).toBe("rgba(255,255,255,0.16)");
    expect(surface.bubbleFg).toBe("#FFFFFF");
  });

  test("mid-tone saturated avatar → soft white lift, near-black text for AA", () => {
    // White-on-color would fail AA here; the bubble text flips to near-black
    // against the lightened blended surface.
    const teal = toneForBg("#3E9B87");
    expect(teal.bubbleBg).toBe("rgba(255,255,255,0.16)");
    expect(teal.bubbleFg).toBe("#1A1A1A");
  });

  test("light avatar (yellow) → soft dark lift, near-black text", () => {
    const tone = toneForBg("#F2C94C");
    expect(tone.isLight).toBe(true);
    expect(tone.bubbleBg).toBe("rgba(0,0,0,0.10)");
    expect(tone.bubbleFg).toBe("#1A1A1A");
  });

  test("bubble text meets WCAG AA against the blended surface on every palette color", () => {
    // A spread across the room's avatar palette (dark + the mid-tone saturated
    // greens/oranges/pinks/purples/teals Codex flagged) plus the light yellow.
    const avatars = [
      "#17191C",
      "#4C9B50",
      "#3E9B87",
      "#E08A3C",
      "#D96BA0",
      "#8E6BD9",
      "#F2C94C",
    ];
    for (const bg of avatars) {
      const { isLight, bubbleFg } = toneForBg(bg);
      const surface = isLight
        ? composite(bg, 0, 0.1)
        : composite(bg, 255, 0.16);
      expect(contrastRatio(bubbleFg, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("base tone fields keep their established values", () => {
    const tone = toneForBg("#17191C");
    expect(tone.fg).toBe("#FFFFFF");
    expect(tone.fgMuted).toBe("rgba(255,255,255,0.65)");
  });
});
