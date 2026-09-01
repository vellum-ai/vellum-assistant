/**
 * Tests for the trait→SVG compositor, focused on the optional eye style.
 * Plan-tier avatars render body-only (eyeless); every other consumer passes a
 * real eye style and must keep its eyes. These assertions lock in both paths:
 * an absent eye style emits exactly one `<path>` (the body) and the body path
 * stays byte-identical whether or not eyes are drawn.
 */

import { describe, expect, test } from "bun:test";

import type { CharacterComponents } from "@/types/avatar";
import { composeSvg, resolveDefinitions } from "@/utils/avatar-svg-compositor";

const components: CharacterComponents = {
  bodyShapes: [
    {
      id: "blob",
      viewBox: { width: 100, height: 100 },
      faceCenter: { x: 50, y: 50 },
      svgPath: "M0 0h100v100H0z",
    },
  ],
  eyeStyles: [
    {
      id: "grumpy",
      sourceViewBox: { width: 40, height: 40 },
      eyeCenter: { x: 20, y: 20 },
      paths: [
        { svgPath: "M10 10h5v5h-5z", color: "#000" },
        { svgPath: "M25 10h5v5h-5z", color: "#000" },
      ],
    },
  ],
  colors: [{ id: "green", hex: "#0f0" }],
  faceCenterOverrides: [],
};

const countPaths = (svg: string): number =>
  (svg.match(/<path\b/g) ?? []).length;

function expectComposedSvg(
  ...args: Parameters<typeof composeSvg>
): string {
  const svg = composeSvg(...args);
  expect(svg).not.toBeNull();
  if (svg == null) {
    throw new Error("expected composeSvg to return an SVG string");
  }
  return svg;
}

describe("composeSvg eye style handling", () => {
  test("emits a body path plus one path per eye path when an eye style is given", () => {
    const svg = expectComposedSvg(components, "blob", "grumpy", "green", 64);
    // 1 body + 2 eye paths.
    expect(countPaths(svg)).toBe(3);
  });

  test("emits only the body path when the eye style is null", () => {
    const svg = expectComposedSvg(components, "blob", null, "green", 64);
    expect(countPaths(svg)).toBe(1);
    expect(svg).toContain(components.bodyShapes[0]!.svgPath);
    // No eye path made it into the output.
    expect(svg).not.toContain(components.eyeStyles[0]!.paths[0]!.svgPath);
  });

  test("emits only the body path when the eye style is omitted (undefined)", () => {
    const svg = expectComposedSvg(components, "blob", undefined, "green", 64);
    expect(countPaths(svg)).toBe(1);
  });

  test("keeps the body path byte-identical whether or not eyes are drawn", () => {
    const withEyes = expectComposedSvg(
      components,
      "blob",
      "grumpy",
      "green",
      64,
    );
    const bodyOnly = expectComposedSvg(components, "blob", null, "green", 64);
    const bodyPath = bodyOnly.replace(/^<svg[^>]*>|<\/svg>$/g, "");
    // The eyed SVG contains exactly the same body path element.
    expect(withEyes).toContain(bodyPath);
  });

  test("returns null for a present-but-unknown eye style id", () => {
    expect(composeSvg(components, "blob", "nope", "green", 64)).toBeNull();
  });

  test("returns null for an unknown body shape id", () => {
    expect(
      composeSvg(components, "stout-pour", "grumpy", "green", 64),
    ).toBeNull();
    expect(
      resolveDefinitions(components, "stout-pour", "grumpy", "green"),
    ).toBeNull();
  });

  test("returns null for an unknown color id", () => {
    expect(composeSvg(components, "blob", "grumpy", "nope", 64)).toBeNull();
  });
});
