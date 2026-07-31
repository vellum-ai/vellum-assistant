/**
 * Tests for `encodeAvatarForIsland`, fitting the assistant avatar inside
 * ActivityKit's payload ceiling.
 *
 * The rasterizer is injected rather than stubbed with `mock.module`: it needs a
 * canvas, and what matters here is the ladder's decision-making, not the
 * pixels. Injection also keeps the stub local, because mocking the module would
 * replace the whole of `avatar-raster` for every test file sharing the process,
 * stripping `coverCropSquare` out from under `avatar-raster.test.ts`.
 *
 * The stub reports a byte size per (size, type) so each test can describe an
 * avatar that compresses well or badly and assert which rung it lands on.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  encodeAvatarForIsland,
  ISLAND_AVATAR_MAX_BYTES,
} from "@/utils/avatar-island-encode";

/** Recorded rasterize attempts, in order, so the ladder's walk is assertable. */
let attempts: Array<{ size: number; type: string; quality?: number }> = [];
/** Bytes the stub returns per attempt, keyed by `<size>:<type>`. */
let byteSizes: Record<string, number> = {};
/** When set, the stub throws instead of returning, as an undrawable source does. */
let throwOnDraw = false;

/** Stands in for the canvas rasterizer, recording each attempt. */
const rasterize = async (
  _src: string,
  size: number,
  type: string,
  quality?: number,
): Promise<Uint8Array | null> => {
  attempts.push({ size, type, quality });
  if (throwOnDraw) {
    throw new Error("source failed to load");
  }
  const bytes = byteSizes[`${size}:${type}`];
  return bytes === undefined ? null : new Uint8Array(bytes);
};

/** `encodeAvatarForIsland` with the stub wired in at its default budget. */
const encode = (render: Parameters<typeof encodeAvatarForIsland>[0]) =>
  encodeAvatarForIsland(render, ISLAND_AVATAR_MAX_BYTES, rasterize as never);

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
    expect(await encode({ kind: "none" })).toBeNull();
    expect(attempts).toHaveLength(0);
  });

  // The character case: flat colors compress well, so it should keep the
  // sharpest rung rather than being scaled down defensively.
  test("takes the largest PNG when it already fits", async () => {
    byteSizes["128:image/png"] = 900;

    expect(await encode(CHARACTER)).not.toBeNull();
    expect(attempts).toEqual([{ size: 128, type: "image/png", quality: undefined }]);
  });

  // The measured shape for the default character avatar: 128px PNG is 6860
  // bytes, 96px 5010, 64px 3366, 48px 2419, and only 40px fits at 1997.
  test("steps down until a rung fits", async () => {
    byteSizes["128:image/png"] = 6860;
    byteSizes["96:image/png"] = 5010;
    byteSizes["64:image/png"] = 3366;
    byteSizes["48:image/png"] = 2419;
    byteSizes["40:image/png"] = 1997;

    expect(await encode(CHARACTER)).not.toBeNull();
    expect(attempts.map((a) => a.size)).toEqual([128, 96, 64, 48, 40]);
  });

  // The photographic case: PNG never fits at any size, so it has to reach the
  // JPEG rungs even though those lose the avatar's transparency.
  test("falls through to JPEG for a source PNG cannot fit", async () => {
    for (const size of [128, 96, 64, 48, 40, 32]) {
      byteSizes[`${size}:image/png`] = 40000;
    }
    byteSizes["64:image/jpeg"] = 1400;

    expect(await encode(IMAGE)).not.toBeNull();
    expect(attempts.at(-1)).toEqual({
      size: 64,
      type: "image/jpeg",
      quality: 0.7,
    });
  });

  // JPEG is matted onto white, which reads as a white disc against the black
  // Dynamic Island, so a PNG that fits must always win even when a JPEG rung
  // would be smaller.
  test("prefers a PNG that fits over a smaller JPEG", async () => {
    byteSizes["128:image/png"] = 40000;
    byteSizes["96:image/png"] = 40000;
    byteSizes["64:image/png"] = 40000;
    byteSizes["48:image/png"] = 1900;
    byteSizes["64:image/jpeg"] = 400;

    expect(await encode(CHARACTER)).not.toBeNull();
    expect(attempts.at(-1)).toEqual({
      size: 48,
      type: "image/png",
      quality: undefined,
    });
  });

  // Going over the ceiling is not a worse avatar, it is no Live Activity at
  // all, so nothing is better than something too big.
  test("returns null when no rung fits rather than sending an oversize payload", async () => {
    for (const size of [128, 96, 64, 48, 40, 32]) {
      byteSizes[`${size}:image/png`] = 99000;
    }
    byteSizes["64:image/jpeg"] = 99000;
    byteSizes["48:image/jpeg"] = 99000;

    expect(await encode(IMAGE)).toBeNull();
    expect(attempts).toHaveLength(8);
  });

  test("accepts a payload exactly on the ceiling", async () => {
    byteSizes["128:image/png"] = ISLAND_AVATAR_MAX_BYTES;

    expect(await encode(CHARACTER)).not.toBeNull();
  });

  // An undrawable source fails identically at every size, so retrying the
  // whole ladder would just be five more failures.
  test("gives up immediately when the source will not draw", async () => {
    throwOnDraw = true;

    expect(await encode(IMAGE)).toBeNull();
    expect(attempts).toHaveLength(1);
  });

  // 3366 bytes threw `attributesTooLarge` on a simulator and produced no Live
  // Activity at all; 1997 rendered. The ceiling is nowhere near the documented
  // 4KB, so this pins the measured value rather than the documented one.
  test("stays under the measured ActivityKit ceiling, not the documented one", () => {
    expect(ISLAND_AVATAR_MAX_BYTES).toBeLessThan(3366);
    expect(ISLAND_AVATAR_MAX_BYTES).toBeGreaterThanOrEqual(1997);
  });
});
