import { describe, expect, test } from "bun:test";

import { coverCropSquare } from "@/hooks/use-electron-icon-sync";

// Locks `object-cover` parity for the Dock/menu-bar icons: a non-square avatar
// must be center-cropped to a square (not stretched), matching the in-app
// `ChatAvatar`. Regressed when the rasterizer used a 4-arg `drawImage` that
// stretched the source to fill the square canvas.
describe("coverCropSquare", () => {
  test("returns the full image unchanged for a square source", () => {
    expect(coverCropSquare(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });

  test("crops the horizontal center of a landscape source", () => {
    // 200×100 → 100px square centered horizontally (50px trimmed each side).
    expect(coverCropSquare(200, 100)).toEqual({ sx: 50, sy: 0, side: 100 });
  });

  test("crops the vertical center of a portrait source", () => {
    // 100×200 → 100px square centered vertically (50px trimmed top/bottom).
    expect(coverCropSquare(100, 200)).toEqual({ sx: 0, sy: 50, side: 100 });
  });

  test("returns null for a degenerate (zero-dimension) source", () => {
    expect(coverCropSquare(0, 100)).toBeNull();
    expect(coverCropSquare(100, 0)).toBeNull();
    expect(coverCropSquare(0, 0)).toBeNull();
  });
});
