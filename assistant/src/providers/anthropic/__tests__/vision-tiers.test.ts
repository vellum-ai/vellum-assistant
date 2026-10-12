import { describe, expect, test } from "bun:test";

import {
  countVisualTokens,
  estimateVisualTokens,
  HIGH_RESOLUTION_VISION_TIER,
  MANY_IMAGE_MAX_DIMENSION_PX,
  resizedImageSize,
  STANDARD_VISION_TIER,
  visionTierForModel,
} from "../vision-tiers.js";

// Expected values are rows of the resolution table in Anthropic's vision docs
// and the A4 scan example of the resize rule:
// https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
// https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images

describe("resizedImageSize", () => {
  test.each([
    // [width, height, standard width, standard height, high-res width, high-res height]
    [200, 200, 200, 200, 200, 200],
    [1000, 1000, 1000, 1000, 1000, 1000],
    [1092, 1092, 1092, 1092, 1092, 1092],
    [1920, 1080, 1456, 819, 1920, 1080],
    [3840, 2160, 1456, 819, 2576, 1449],
  ])("%dx%d downsizes as the docs table shows", (w, h, sw, sh, hw, hh) => {
    expect(resizedImageSize(w, h, STANDARD_VISION_TIER)).toEqual({
      width: sw,
      height: sh,
    });
    expect(resizedImageSize(w, h, HIGH_RESOLUTION_VISION_TIER)).toEqual({
      width: hw,
      height: hh,
    });
  });

  test("downsizes when only the visual-token limit is exceeded", () => {
    // An A4 page scanned at 130 DPI: both sides are under the standard edge
    // limit, yet 39 x 55 patches exceed 1568 tokens. The high-resolution tier
    // leaves it alone.
    expect(resizedImageSize(1075, 1520, STANDARD_VISION_TIER)).toEqual({
      width: 924,
      height: 1307,
    });
    expect(resizedImageSize(1075, 1520, HIGH_RESOLUTION_VISION_TIER)).toEqual({
      width: 1075,
      height: 1520,
    });
  });

  test("sizes a portrait image as the rotation of its landscape twin", () => {
    expect(resizedImageSize(1080, 1920, STANDARD_VISION_TIER)).toEqual({
      width: 819,
      height: 1456,
    });
  });
});

describe("estimateVisualTokens", () => {
  test.each([
    // [width, height, standard tokens, high-res tokens]
    [200, 200, 64, 64],
    [1000, 1000, 1296, 1296],
    [1092, 1092, 1521, 1521],
    [1920, 1080, 1560, 2691],
    [2000, 1500, 1564, 3888],
    [3840, 2160, 1560, 4784],
  ])("%dx%d costs the docs table's tokens on each tier", (w, h, std, high) => {
    expect(estimateVisualTokens(w, h, STANDARD_VISION_TIER)).toBe(std);
    expect(estimateVisualTokens(w, h, HIGH_RESOLUTION_VISION_TIER)).toBe(high);
  });

  test("never exceeds the tier's visual-token limit", () => {
    const sizes: Array<[number, number]> = [
      [8000, 8000],
      [8000, 1],
      [1, 8000],
      [5000, 3333],
      [2577, 2577],
      [1569, 1569],
    ];
    for (const [w, h] of sizes) {
      expect(
        estimateVisualTokens(w, h, STANDARD_VISION_TIER),
      ).toBeLessThanOrEqual(STANDARD_VISION_TIER.maxVisualTokens);
      expect(
        estimateVisualTokens(w, h, HIGH_RESOLUTION_VISION_TIER),
      ).toBeLessThanOrEqual(HIGH_RESOLUTION_VISION_TIER.maxVisualTokens);
    }
  });

  test("costs a size that is not a pair of positive finite numbers at the tier maximum", () => {
    const sizes: Array<[number, number]> = [
      [0, 0],
      [0, 100],
      [-5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ];
    for (const [w, h] of sizes) {
      expect(estimateVisualTokens(w, h, STANDARD_VISION_TIER)).toBe(1568);
      expect(estimateVisualTokens(w, h, HIGH_RESOLUTION_VISION_TIER)).toBe(
        4784,
      );
    }
  });

  test("counts one token per 28 px patch, rounding partial patches up", () => {
    expect(countVisualTokens(28, 28)).toBe(1);
    expect(countVisualTokens(29, 28)).toBe(2);
    expect(countVisualTokens(1568, 1568)).toBe(56 * 56);
  });
});

describe("visionTierForModel", () => {
  test.each([
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-4-7-20260416",
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-5.5",
    "claude-4-7-opus-20260416",
  ])("%s is on the high-resolution tier", (model) => {
    expect(visionTierForModel(model)).toBe(HIGH_RESOLUTION_VISION_TIER);
  });

  test.each([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-4.5",
    "claude-opus-4-5-20251101",
    "claude-3-5-sonnet-20241022",
    "gpt-5",
    "gemini-2.5-pro",
    "",
  ])("%j is on the standard tier", (model) => {
    expect(visionTierForModel(model)).toBe(STANDARD_VISION_TIER);
  });

  test("an unknown model is costed on the standard tier", () => {
    expect(visionTierForModel(undefined)).toBe(STANDARD_VISION_TIER);
  });
});

test("the many-image dimension cap sits between the tiers' edges", () => {
  // Read-time scaling to the standard tier's edge keeps every image under the
  // cap; scaling to the high-resolution tier's edge could not.
  expect(STANDARD_VISION_TIER.maxEdgePx).toBeLessThanOrEqual(
    MANY_IMAGE_MAX_DIMENSION_PX,
  );
  expect(HIGH_RESOLUTION_VISION_TIER.maxEdgePx).toBeGreaterThan(
    MANY_IMAGE_MAX_DIMENSION_PX,
  );
});
