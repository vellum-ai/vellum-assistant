/**
 * Tests for `toneForBg`'s user-bubble surface tokens (`bubbleBg`/`bubbleFg`).
 *
 * Pins the contract that the bubble is a soft translucent raised lift toned to
 * the room — a subtle white wash + white text over dark or saturated avatars, a
 * subtle dark wash + near-black text over the one light avatar color (yellow) —
 * while the base tone fields (`fg`/`fgMuted`) keep their established values.
 */

import { describe, expect, test } from "bun:test";

import { toneForBg } from "./avatar-tone";

describe("toneForBg bubble tokens", () => {
  test("dark bg yields a soft white lift with white text", () => {
    const surface = toneForBg("#17191C");
    expect(surface.bubbleBg).toBe("rgba(255,255,255,0.16)");
    expect(surface.bubbleFg).toBe("#FFFFFF");

    const teal = toneForBg("#3E9B87");
    expect(teal.bubbleBg).toBe("rgba(255,255,255,0.16)");
    expect(teal.bubbleFg).toBe("#FFFFFF");
  });

  test("light bg (yellow) yields a soft dark lift with near-black text", () => {
    const tone = toneForBg("#F2C94C");
    expect(tone.isLight).toBe(true);
    expect(tone.bubbleBg).toBe("rgba(0,0,0,0.10)");
    expect(tone.bubbleFg).toBe("#1A1A1A");
  });

  test("base tone fields keep their established values", () => {
    const tone = toneForBg("#17191C");
    expect(tone.fg).toBe("#FFFFFF");
    expect(tone.fgMuted).toBe("rgba(255,255,255,0.65)");
  });
});
