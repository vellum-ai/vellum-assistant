/**
 * Tests for `encodeAvatarForIsland` — fitting the assistant avatar inside
 * ActivityKit's payload ceiling.
 *
 * `rasterizeAvatar` is stubbed at the module boundary: it needs a canvas, and
 * what matters here is the ladder's decision-making, not the pixels. The stub
 * reports a byte size per (size, type) so each test can describe an avatar
 * that compresses well or badly and assert which rung it lands on.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Recorded rasterize attempts, in order, so the ladder's walk is assertable. */
let attempts: Array<{ size: number; type: string; quality?: number }> = [];
/** Bytes the stub returns per attempt, keyed by `<size>:<type>`. */
let byteSizes: Record<string, number> = {};
/** When set, the stub throws instead of returning, as an undrawable source does. */
let throwOnDraw = false;

mock.module("@/utils/avatar-raster", () => ({
  rasterizeAvatar: async (
    _src: string,
    size: number,
    type: string,
    quality?: number,
  ) => {
    attempts.push({ size, type, quality });
    if (throwOnDraw) {
      throw new Error("source failed to load");
    }
    const bytes = byteSizes[`${size}:${type}`];
    return bytes === undefined ? null : new Uint8Array(bytes);
  },
}));

const { encodeAvatarForIsland, ISLAND_AVATAR_MAX_BYTES } = await import(
  "@/utils/avatar-island-encode"
);

const CHARACTER = {
  kind: "character" as const,
  svg: "<svg/>",
  dataUri: "data:image/svg+xml,%3Csvg/%3E",
};
const IMAGE = { kind: "image" as const, url: "blob:avatar" };

beforeEach(() => {
  attempts = [];
  byteSizes = {};
  throwOnDraw = false;
});

describe("encodeAvatarForIsland", () => {
  test("returns null for an assistant with no avatar, without rasterizing", async () => {
    expect(await encodeAvatarForIsland({ kind: "none" })).toBeNull();
    expect(attempts).toHaveLength(0);
  });

  // The character case: flat colors compress well, so it should keep the
  // sharpest rung rather than being scaled down defensively.
  test("takes the largest PNG when it already fits", async () => {
    byteSizes["128:image/png"] = 900;

    expect(await encodeAvatarForIsland(CHARACTER)).not.toBeNull();
    expect(attempts).toEqual([{ size: 128, type: "image/png", quality: undefined }]);
  });

  test("steps down until a rung fits", async () => {
    byteSizes["128:image/png"] = 9000;
    byteSizes["96:image/png"] = 4000;
    byteSizes["64:image/png"] = 1200;

    expect(await encodeAvatarForIsland(CHARACTER)).not.toBeNull();
    expect(attempts.map((a) => a.size)).toEqual([128, 96, 64]);
  });

  // The photographic case: PNG never fits, so it has to reach the JPEG rungs.
  test("falls through to JPEG for a source PNG cannot fit", async () => {
    byteSizes["128:image/png"] = 40000;
    byteSizes["96:image/png"] = 22000;
    byteSizes["64:image/png"] = 9000;
    byteSizes["96:image/jpeg"] = 1400;

    expect(await encodeAvatarForIsland(IMAGE)).not.toBeNull();
    expect(attempts.at(-1)).toEqual({
      size: 96,
      type: "image/jpeg",
      quality: 0.75,
    });
  });

  // Going over the ceiling is not a worse avatar, it is no Live Activity at
  // all, so nothing is better than something too big.
  test("returns null when no rung fits rather than sending an oversize payload", async () => {
    byteSizes = {
      "128:image/png": 99000,
      "96:image/png": 99000,
      "64:image/png": 99000,
      "96:image/jpeg": 99000,
      "64:image/jpeg": 99000,
      "48:image/jpeg": 99000,
    };

    expect(await encodeAvatarForIsland(IMAGE)).toBeNull();
    expect(attempts).toHaveLength(6);
  });

  test("accepts a payload exactly on the ceiling", async () => {
    byteSizes["128:image/png"] = ISLAND_AVATAR_MAX_BYTES;

    expect(await encodeAvatarForIsland(CHARACTER)).not.toBeNull();
  });

  // An undrawable source fails identically at every size, so retrying the
  // whole ladder would just be five more failures.
  test("gives up immediately when the source will not draw", async () => {
    throwOnDraw = true;

    expect(await encodeAvatarForIsland(IMAGE)).toBeNull();
    expect(attempts).toHaveLength(1);
  });

  test("stays under ActivityKit's documented 4KB attribute ceiling", () => {
    expect(ISLAND_AVATAR_MAX_BYTES).toBeLessThan(4096);
  });
});
