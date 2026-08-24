/**
 * The color math behind an uploaded avatar's room-fill color. The canvas half
 * (`sampleAvatarFieldHex`) is not exercised here, because no test environment
 * decodes an image. The sampling is split so the part that decides the color
 * can be tested from pixels alone.
 */

import { describe, expect, test } from "bun:test";

import {
  fieldHexFromImageData,
  normalizeFieldHex,
} from "./avatar-image-color";

/** Build an RGBA block from `[r, g, b, a]` tuples, each repeated `count` times. */
function pixels(...runs: [number, number, number, number, number][]) {
  const out: number[] = [];
  for (const [r, g, b, a, count] of runs) {
    for (let i = 0; i < count; i += 1) {
      out.push(r, g, b, a);
    }
  }
  return new Uint8ClampedArray(out);
}

/** Perceived brightness (YIQ), the same measure `toneForBg` reads. */
function brightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => c / 255);
  const max = Math.max(...ch);
  const min = Math.min(...ch);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

describe("normalizeFieldHex", () => {
  test("pins every color into the band the room's ink was tuned against", () => {
    // Anything drawn over an avatar color assumes the character palette's
    // range. A near-white or near-black upload has to land there too, or the
    // pale/dark band ink stops reading.
    for (const hex of ["#FFFFFF", "#000000", "#FF0000", "#123456"]) {
      expect(brightness(normalizeFieldHex(hex))).toBeGreaterThan(0.3);
      expect(brightness(normalizeFieldHex(hex))).toBeLessThan(0.62);
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

describe("fieldHexFromImageData", () => {
  test("lets the colored pixels carry a logo on a white ground", () => {
    // A flat average of a red mark on white is pale pink, which is how every
    // logo upload ends up with the same washed-out room.
    const hex = fieldHexFromImageData(
      pixels([255, 255, 255, 255, 90], [200, 30, 30, 255, 10]),
    );
    const n = parseInt(hex!.slice(1), 16);
    expect((n >> 16) & 0xff).toBeGreaterThan((n >> 8) & 0xff);
    expect(saturation(hex!)).toBeGreaterThan(0.2);
  });

  test("skips transparent pixels: a cutout's ground is not its color", () => {
    const cutout = fieldHexFromImageData(
      pixels([0, 0, 0, 0, 90], [40, 120, 200, 255, 10]),
    );
    const opaque = fieldHexFromImageData(pixels([40, 120, 200, 255, 10]));
    expect(cutout).toBe(opaque);
  });

  test("returns null when nothing is opaque enough to sample", () => {
    expect(fieldHexFromImageData(pixels([12, 34, 56, 0, 40]))).toBeNull();
  });

  test("returns null for an empty block", () => {
    expect(fieldHexFromImageData(new Uint8ClampedArray())).toBeNull();
  });
});
