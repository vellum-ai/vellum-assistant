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

import {
  contrastForeground,
  legibleAccentFill,
  toneForBg,
} from "./avatar-tone";

const FG_DARK = "#1A1A1A";
const FG_LIGHT = "#FFFFFF";

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

/** The largest per-channel move between two #rrggbb hexes, 0 to 255. */
function maxChannelDelta(a: string, b: string): number {
  const [x, y] = [a, b].map((h) => parseInt(h.replace("#", ""), 16));
  return Math.max(
    ...[16, 8, 0].map((shift) =>
      Math.abs(((x! >> shift) & 0xff) - ((y! >> shift) & 0xff)),
    ),
  );
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("contrastForeground", () => {
  test("a light background takes the near-black", () => {
    expect(contrastForeground("#E9C91A")).toBe(FG_DARK);
    expect(contrastForeground("#F2C94C")).toBe(FG_DARK);
  });

  test("a dark background takes the white", () => {
    expect(contrastForeground("#17191C")).toBe(FG_LIGHT);
    expect(contrastForeground("#20336B")).toBe(FG_LIGHT);
  });

  test("a mid-tone background takes whichever actually measures higher", () => {
    // The near-black loses here, by a ratio the caller can check: 3.83 against
    // white's 4.54. A cutoff read off pure black hands this one dark ink.
    expect(contrastRatio(FG_DARK, "#767676")).toBeLessThan(
      contrastRatio(FG_LIGHT, "#767676"),
    );
    expect(contrastForeground("#767676")).toBe(FG_LIGHT);
  });

  test("the crossover is the luminance where the two ratios meet", () => {
    // The two 8-bit greys either side of it, so the pair brackets the point
    // rather than pinning a constant nothing computes. #7C7C7C is the near
    // tie: 4.170 dark against 4.174 white.
    expect(contrastForeground("#7C7C7C")).toBe(FG_LIGHT);
    expect(contrastForeground("#7D7D7D")).toBe(FG_DARK);
    expect(luminance("#7C7C7C")).toBeLessThan(0.201687);
    expect(luminance("#7D7D7D")).toBeGreaterThan(0.201687);
  });

  test("every avatar palette colour keeps the ink it ships with", () => {
    for (const hex of ["#4C9B50", "#E9642F", "#DB4B77", "#A665C9", "#0E9B8B"]) {
      expect(contrastForeground(hex)).toBe(FG_DARK);
    }
  });
});

/** The bundled avatar palette, which is what most assistants are wearing. */
const PALETTE = [
  "#4C9B50",
  "#E9642F",
  "#DB4B77",
  "#A665C9",
  "#0E9B8B",
  "#E9C91A",
];

describe("legibleAccentFill", () => {
  test("every colour it returns carries text at the AA floor", () => {
    // The guarantee, not a list of instances: two inks leave a band of
    // mid-tones neither can letter, and an accent is any colour an image or a
    // user hands over. The sweep walks the whole grey ramp through that band,
    // both ends of the range, and the palette.
    const inputs = [...PALETTE, "#000000", "#FFFFFF", "#cf4370", "#20336B"];
    for (let g = 0; g < 256; g++) {
      const c = g.toString(16).padStart(2, "0");
      inputs.push(`#${c}${c}${c}`);
    }
    for (const hue of ["#8A6A6A", "#6A8A6A", "#6A6A8A", "#9A8A5A", "#f90000"]) {
      inputs.push(hue);
    }

    for (const accent of inputs) {
      const fill = legibleAccentFill(accent);
      expect(
        contrastRatio(contrastForeground(fill), fill),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("an accent that already carries text is handed back untouched", () => {
    // Four of the six palette colours, and a dark uploaded one: the fill is the
    // accent itself and the assistant wears the exact hex it was given.
    for (const accent of [
      "#4C9B50",
      "#E9642F",
      "#0E9B8B",
      "#E9C91A",
      "#20336B",
    ]) {
      expect(legibleAccentFill(accent)).toBe(accent);
    }
  });

  test("the two palette colours that miss the floor move by a hair to reach it", () => {
    // Pink and purple land at 4.38 and 4.41 on the near-black, just under the
    // floor, so their fill lightens until they clear it. The move is smaller
    // than the difference a viewer can see with the two side by side, and it
    // is the whole distance between an AA label and one that misses.
    for (const accent of ["#DB4B77", "#A665C9"]) {
      const fill = legibleAccentFill(accent);
      expect(fill).not.toBe(accent);
      expect(contrastRatio(contrastForeground(accent), accent)).toBeLessThan(
        4.5,
      );
      expect(
        contrastRatio(contrastForeground(fill), fill),
      ).toBeGreaterThanOrEqual(4.5);
      expect(maxChannelDelta(fill, accent)).toBeLessThanOrEqual(4);
    }
  });

  test("a mid-grey moves to the near edge of the band and no further", () => {
    // #7C7C7C sits below the middle of the band, so it darkens until white
    // letters it rather than lightening the longer way to the near-black.
    const fill = legibleAccentFill("#7C7C7C");
    expect(contrastForeground(fill)).toBe(FG_LIGHT);
    expect(luminance(fill)).toBeLessThan(luminance("#7C7C7C"));
    expect(contrastRatio(FG_LIGHT, fill)).toBeGreaterThanOrEqual(4.5);
    // A nudge, not a repaint.
    expect(luminance("#7C7C7C") - luminance(fill)).toBeLessThan(0.03);
  });

  test("a grey above the middle of the band lightens instead", () => {
    const fill = legibleAccentFill("#818181");
    expect(contrastForeground(fill)).toBe(FG_DARK);
    expect(luminance(fill)).toBeGreaterThan(luminance("#818181"));
  });
});

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
