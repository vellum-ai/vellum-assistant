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

function stylesheet(): string {
  return readFileSync(
    new URL("../../../../index.css", import.meta.url),
    "utf8",
  );
}

/** What the feature query's fill reads when no accent is published. */
function modernFallbackFromStylesheet(): string {
  const match =
    /--camera-live-fill:\s*var\(--avatar-accent-fill,\s*([^)]+)\)/.exec(
      stylesheet(),
    );
  return match?.[1]?.trim() ?? "";
}

/**
 * What an engine without color-mix() paints, which is the base rule's own
 * `background-color` rather than anything inside the query.
 */
function legacyFillFromStylesheet(): string {
  const css = stylesheet();
  const rule = css.slice(css.indexOf(".camera-live-fill {"));
  const match = /background-color:\s*([^;]+);/.exec(
    rule.slice(0, rule.indexOf("}")),
  );
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

  test("is the same value the stylesheet falls back to, on both engine paths", () => {
    // The drift guard. `index.css` cannot call `legibleAccentFill`, so it
    // repeats the answer twice, and a repeated value needs something holding
    // it. One crimson across both paths is also one colour to reason about.
    expect(modernFallbackFromStylesheet().toLowerCase()).toBe(
      CAMERA_FILL_FALLBACK.toLowerCase(),
    );
    expect(legacyFillFromStylesheet().toLowerCase()).toBe(
      CAMERA_FILL_FALLBACK.toLowerCase(),
    );
  });

  test("is opaque, so the frame behind it cannot move the label's contrast", () => {
    // A translucent fill composites with arbitrary video, which is what put
    // the legacy label between 3.87 and 4.48 depending on what the lens saw.
    expect(legacyFillFromStylesheet()).toMatch(/^#[0-9a-f]{6}$/i);
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
