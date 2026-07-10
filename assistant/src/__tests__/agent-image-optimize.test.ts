import { describe, expect, it } from "bun:test";

import {
  isBelowMinDimension,
  MIN_IMAGE_DIMENSION,
  shouldRescaleImage,
  upscaleTargetDimensions,
} from "../agent/image-optimize.js";

describe("shouldRescaleImage", () => {
  it("rescales when any side exceeds the max dimension, regardless of file size", () => {
    // Regression: a sparse screenshot can be tiny in bytes but 3000+ px wide,
    // which Anthropic rejects in many-image requests with a 2000 px cap.
    expect(shouldRescaleImage({ width: 3000, height: 900 }, 50_000)).toBe(true);
    expect(shouldRescaleImage({ width: 900, height: 3000 }, 50_000)).toBe(true);
  });

  it("skips rescale when dimensions are known and within limits", () => {
    expect(shouldRescaleImage({ width: 1200, height: 800 }, 50_000)).toBe(
      false,
    );
  });

  it("rescales when raw bytes would inflate past Anthropic's 5 MB base64 cap", () => {
    // Regression: an oversized image retained across compaction was rejected
    // with "image.source.base64: image exceeds 5 MB maximum" even though
    // dimensions were within the 1568 px cap. base64 inflates raw bytes by
    // 4/3, so anything over ~3.5 MB raw risks crossing the 5 MB API limit.
    expect(shouldRescaleImage({ width: 1568, height: 1568 }, 5_000_000)).toBe(
      true,
    );
    expect(shouldRescaleImage({ width: 1200, height: 800 }, 4_000_000)).toBe(
      true,
    );
  });

  it("falls back to file size when dimensions are unparseable", () => {
    expect(shouldRescaleImage(null, 50_000)).toBe(false);
    expect(shouldRescaleImage(null, 5_000_000)).toBe(true);
  });
});

describe("isBelowMinDimension", () => {
  it("flags an image with any side under the minimum floor", () => {
    // Regression: Anthropic rejects tiny images with a 400 "Could not
    // process image" (observed with a 16×14 px upload).
    expect(isBelowMinDimension({ width: 16, height: 14 })).toBe(true);
    expect(isBelowMinDimension({ width: 1024, height: 20 })).toBe(true);
  });

  it("leaves images at or above the floor alone", () => {
    expect(
      isBelowMinDimension({
        width: MIN_IMAGE_DIMENSION,
        height: MIN_IMAGE_DIMENSION,
      }),
    ).toBe(false);
    expect(isBelowMinDimension({ width: 1200, height: 800 })).toBe(false);
  });

  it("never flags unparseable dimensions — byte size cannot prove smallness", () => {
    expect(isBelowMinDimension(null)).toBe(false);
  });
});

describe("upscaleTargetDimensions", () => {
  it("lifts the short side to the minimum floor, preserving aspect ratio", () => {
    const target = upscaleTargetDimensions({ width: 16, height: 14 });
    expect(target).not.toBeNull();
    expect(Math.min(target!.width, target!.height)).toBe(MIN_IMAGE_DIMENSION);
    // 16:14 aspect carried through the upscale (±1 px rounding).
    expect(target!.width / target!.height).toBeCloseTo(16 / 14, 1);
  });

  it("returns null for an image already at the floor", () => {
    expect(
      upscaleTargetDimensions({
        width: MIN_IMAGE_DIMENSION,
        height: MIN_IMAGE_DIMENSION,
      }),
    ).toBeNull();
  });

  it("caps the long side at the transport max for extreme aspect ratios", () => {
    // A 4×2000 sliver cannot reach a 64 px short side without blowing the
    // 1568 px long-side cap; the scale is clamped to the cap instead.
    const target = upscaleTargetDimensions({ width: 4, height: 2000 });
    expect(target).toBeNull();
  });
});
