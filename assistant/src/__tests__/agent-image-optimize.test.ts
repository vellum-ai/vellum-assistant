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
    // Even a large file is fine as long as dimensions are within limits —
    // Anthropic's constraint is per-side pixels, not bytes.
    expect(shouldRescaleImage({ width: 1568, height: 1568 }, 5_000_000)).toBe(
      false,
    );
  });

  it("falls back to file size when dimensions are unparseable", () => {
    expect(shouldRescaleImage(null, 50_000)).toBe(false);
    expect(shouldRescaleImage(null, 5_000_000)).toBe(true);
  });
});
