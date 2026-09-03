/**
 * The room's treatment of an uploaded avatar's accent. The canvas half
 * (`sampleAvatarAccentHex`) is not exercised here, because no test environment
 * decodes an image, and the colour it samples is `dominantAccentHex`, tested
 * in `@vellumai/avatar-manifest`.
 */

import { describe, expect, test } from "bun:test";

import { normalizeFieldHex } from "./avatar-image-color";

/** Perceived brightness (YIQ), the same measure `toneForBg` reads. */
function brightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/** WCAG relative luminance, for the contrast check below. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
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

function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => c / 255);
  const max = Math.max(...ch);
  const min = Math.min(...ch);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

/** Fully saturated samples right around the hue wheel, plus the achromatic ends. */
const HUE_SWEEP = [
  "#FF0000",
  "#FF8000",
  "#FFFF00",
  "#80FF00",
  "#00FF00",
  "#00FF80",
  "#00FFFF",
  "#0080FF",
  "#0000FF",
  "#8000FF",
  "#FF00FF",
  "#FF0080",
  "#FFFFFF",
  "#000000",
  "#123456",
  "#8A8A8A",
];

describe("normalizeFieldHex", () => {
  test("pins every hue into the band the room's ink was tuned against", () => {
    // Perceived brightness, which is what decides whether the pale and dark
    // band inks read, and it is not HSL lightness: the eye weights green about
    // five times blue, so a hue-blind normalization leaves saturated blues half
    // as bright as saturated yellows and the dark ink vanishes into them.
    for (const hex of HUE_SWEEP) {
      const b = brightness(normalizeFieldHex(hex));
      expect({ hex, b }).toMatchObject({ hex });
      expect(b).toBeGreaterThan(0.4);
      expect(b).toBeLessThan(0.5);
    }
  });

  test("keeps both band inks legible on every hue", () => {
    // The two inks are the room's whole account of whose turn it is. A field
    // that swallows either one takes that away, whatever the avatar looks like.
    for (const hex of HUE_SWEEP) {
      const field = normalizeFieldHex(hex);
      expect(contrastRatio(field, "#FFFFFF")).toBeGreaterThan(2.4);
      expect(contrastRatio(field, "#000000")).toBeGreaterThan(2.4);
    }
  });

  test("keeps the hue it was given", () => {
    // A blue avatar must not come back green: the field is the assistant's
    // color, normalized, not a color of the room's choosing.
    const blue = normalizeFieldHex("#0A1F7A");
    const n = parseInt(blue.slice(1), 16);
    expect(n & 0xff).toBeGreaterThan((n >> 16) & 0xff);
  });

  test("caps saturation so a one-ink logo is not a headache full-screen", () => {
    expect(saturation(normalizeFieldHex("#FF0000"))).toBeLessThanOrEqual(0.69);
  });

  test("leaves a gray avatar gray rather than inventing a hue", () => {
    expect(saturation(normalizeFieldHex("#8A8A8A"))).toBeLessThan(0.02);
  });

  test("returns a malformed input untouched", () => {
    expect(normalizeFieldHex("not-a-color")).toBe("not-a-color");
  });
});
