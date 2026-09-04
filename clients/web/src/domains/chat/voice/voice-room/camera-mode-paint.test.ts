/**
 * Tests for the camera's paint contract, and for the one value in it that
 * exists twice.
 *
 * `.camera-live-fill` needs a fallback colour for an assistant with no accent,
 * and CSS cannot call a function, so the clamped crimson is written into
 * `index.css` by hand as well as derived here. That is a copy, and a copy
 * drifts, so this reads the stylesheet and holds the two equal.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { contrastForeground, legibleAccentFill } from "@/utils/avatar-tone";

import {
  CAMERA_ACCENT,
  CAMERA_FILL_FALLBACK,
  cameraModeStyle,
} from "./camera-mode-paint";

/** The value `.camera-live-fill` falls back to when no accent is published. */
function fillFallbackFromStylesheet(): string {
  const css = readFileSync(
    new URL("../../../../index.css", import.meta.url),
    "utf8",
  );
  const match =
    /--camera-live-fill:\s*var\(--avatar-accent-fill,\s*([^)]+)\)/.exec(css);
  return match?.[1]?.trim() ?? "";
}

describe("the camera's fill fallback", () => {
  test("is the crimson put through the same clamp every accent goes through", () => {
    expect(CAMERA_FILL_FALLBACK).toBe(legibleAccentFill(CAMERA_ACCENT));
    // The raw crimson is what it moves off: 4.48 against a floor of 4.5.
    expect(CAMERA_FILL_FALLBACK).not.toBe(CAMERA_ACCENT);
  });

  test("carries the white the pill inks it with", () => {
    // The CSS fallback ink is a literal `#fff`, so the clamp has to land
    // somewhere white still wins. A colour that flipped to the near-black here
    // would be lettered in white anyway.
    expect(contrastForeground(CAMERA_FILL_FALLBACK)).toBe("#FFFFFF");
  });

  test("is the same value the stylesheet falls back to", () => {
    // The drift guard. `index.css` cannot call `legibleAccentFill`, so it
    // repeats the answer, and a repeated value needs something holding it.
    expect(fillFallbackFromStylesheet().toLowerCase()).toBe(
      CAMERA_FILL_FALLBACK.toLowerCase(),
    );
  });
});

describe("cameraModeStyle", () => {
  test("publishes the accent with the raw crimson behind it", () => {
    // The chrome drawn over video (ring, hint, thumb ring) reads this one, and
    // it is not clamped: a mark with no text on it has no floor to meet.
    const style = cameraModeStyle() as Record<string, string>;
    expect(style["--camera-accent"]).toBe(
      `var(--avatar-accent, ${CAMERA_ACCENT})`,
    );
  });
});
