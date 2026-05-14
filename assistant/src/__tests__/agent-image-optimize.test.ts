import { describe, expect, it } from "bun:test";

import { shouldRescaleImage } from "../agent/image-optimize.js";

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
