/**
 * Tests for `toneForBg`'s user-bubble surface tokens (`bubbleBg`/`bubbleFg`).
 *
 * Pins the contract that the bubble is a raised surface contrasting the
 * avatar color — white/near-black over dark or saturated avatars, inverted
 * to dark/white over the one light avatar color (yellow) — while the base
 * tone fields (`fg`/`fgMuted`) keep their established values.
 */

import { describe, expect, test } from "bun:test";

import { toneForBg } from "./avatar-tone";

describe("toneForBg bubble tokens", () => {
  test("dark bg yields a white bubble with near-black text", () => {
    const surface = toneForBg("#17191C");
    expect(surface.bubbleBg).toBe("#FFFFFF");
    expect(surface.bubbleFg).toBe("#1A1A1A");

    const teal = toneForBg("#3E9B87");
    expect(teal.bubbleBg).toBe("#FFFFFF");
    expect(teal.bubbleFg).toBe("#1A1A1A");
  });

  test("light bg (yellow) inverts to a dark bubble with white text", () => {
    const tone = toneForBg("#F2C94C");
    expect(tone.isLight).toBe(true);
    expect(tone.bubbleBg).toBe("#1A1A1A");
    expect(tone.bubbleFg).toBe("#FFFFFF");
  });

  test("base tone fields keep their established values", () => {
    const tone = toneForBg("#17191C");
    expect(tone.fg).toBe("#FFFFFF");
    expect(tone.fgMuted).toBe("rgba(255,255,255,0.65)");
  });
});
