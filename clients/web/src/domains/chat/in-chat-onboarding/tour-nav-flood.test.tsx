/**
 * Tests for `TourNavFlood`'s shape: the overlay follows the target it covers.
 * A pill target gets the rounded row with its label beside the eyes; a
 * square target is one of the rail's round tiles, so the overlay rounds
 * fully, drops the label, and centres eyes sized to fit the disc.
 *
 * Rendered with `renderToStaticMarkup`, so no animation runs. What is under
 * test is the branch that picks the overlay's geometry, which is pure.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { REST_SCALE, eyeStyleBaseWidth } from "@/utils/assistant-eyes";

import { TourNavFlood, type TourEyeArt } from "./tour-nav-flood";

/* A square sprite, so the rendered height equals the rendered width and the
   fit is readable from either. */
const EYE: TourEyeArt = {
  id: "curious",
  paths: [{ svgPath: "M0 0h10v10H0z", color: "#000" }],
  bbox: { x: 0, y: 0, w: 10, h: 10 },
};

function renderFlood(width: number, height: number): string {
  return renderToStaticMarkup(
    createElement(TourNavFlood, {
      rect: { left: 10, top: 20, width, height },
      label: "New Chat",
      hex: "#ff8800",
      eye: EYE,
      phase: "enter",
    }),
  );
}

describe("TourNavFlood", () => {
  test("a pill target floods as a rounded row with its label", () => {
    const html = renderFlood(180, 36);
    expect(html).toContain("rounded-[8px]");
    expect(html).not.toContain("rounded-full");
    expect(html).toContain(">New Chat<");
    // The eyes rest at the pill's own scale, inset from its right edge.
    expect(html).toContain(`width:${eyeStyleBaseWidth(EYE.id) * REST_SCALE}px`);
    expect(html).toContain("right:");
  });

  test("a disc target floods as a circle with no label and centred eyes", () => {
    const size = 32;
    const html = renderFlood(size, size);
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("rounded-[8px]");
    expect(html).not.toContain("New Chat");
    // The eyes are capped to fit the disc rather than grown to the resting
    // scale, and stand centred in it.
    const base = eyeStyleBaseWidth(EYE.id);
    const eyesWidth = Math.min(base * REST_SCALE, size - 4);
    expect(eyesWidth).toBeLessThan(base * REST_SCALE);
    expect(html).toContain(`left:${(size - eyesWidth) / 2}px`);
    expect(html).toContain(`width:${eyesWidth}px`);
    expect(html).not.toContain("right:");
  });
});
