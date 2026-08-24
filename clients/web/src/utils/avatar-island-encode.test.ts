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
  __resetAvatarEncodeMemoForTesting,
  encodeAvatarForIsland,
  ISLAND_AVATAR_MAX_BYTES,
  memoizedAvatarEncode,
} from "@/utils/avatar-island-encode";
import type { AvatarRender } from "@/utils/avatar-render";

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
    expect(attempts).toEqual([
      { size: 128, type: "image/png", quality: undefined },
    ]);
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
  // whole ladder would just be seven more failures.
  test("gives up immediately when the source will not draw", async () => {
    throwOnDraw = true;

    await expect(encode(IMAGE)).rejects.toThrow("source failed to load");
    expect(attempts).toHaveLength(1);
  });

  // The line the memo's caching depends on. Null is a fact about the avatar
  // (nothing to draw, nothing that fits), and only a fact may be cached; a draw
  // that failed says nothing about the avatar, so it has to arrive as a
  // rejection or one bad canvas pins "no avatar" for the whole session.
  test("rejects a failed draw rather than reporting it as nothing to send", async () => {
    throwOnDraw = true;

    await expect(encode(CHARACTER)).rejects.toThrow();
  });

  // The rasterizer's other failure: a 2d context the shell would not give up,
  // or a `toBlob` that produced no blob. Same class as a throw, and no later
  // rung draws on a canvas the first one could not get.
  test("rejects when the rasterizer hands back no bytes", async () => {
    // `byteSizes` is empty, so the stub returns null for the first rung.
    await expect(encode(CHARACTER)).rejects.toThrow();
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

/**
 * The memo both native surfaces read through: the Live Activity at
 * ActivityKit's ceiling and the Home Screen widget snapshot at its own, larger
 * one. The encoder is injected here the way the rasterizer is above, so these
 * cases are about what is cached rather than about the ladder.
 */
describe("memoizedAvatarEncode", () => {
  /** A fresh character render, so each case starts on a cache miss. */
  const source = (): AvatarRender => ({
    kind: "character",
    svg: "<svg/>",
    dataUri: "data:image/svg+xml,%3Csvg/%3E",
  });

  const WIDGET_BUDGET = 64_000;

  let encodeCalls = 0;
  let encodeOutcome: "bytes" | "nothing-fits" | "throws" = "bytes";

  const encode = async (): Promise<string | null> => {
    encodeCalls += 1;
    if (encodeOutcome === "throws") {
      throw new Error("canvas unavailable");
    }
    return encodeOutcome === "bytes" ? "Zm9vYmFy" : null;
  };

  const memo = (render: AvatarRender, maxBytes = ISLAND_AVATAR_MAX_BYTES) =>
    memoizedAvatarEncode(render, maxBytes, encode);

  beforeEach(() => {
    __resetAvatarEncodeMemoForTesting();
    encodeCalls = 0;
    encodeOutcome = "bytes";
  });

  test("encodes an avatar once however many surfaces ask for it", async () => {
    const render = source();

    const first = memo(render);
    expect(await first.pending).toBe("Zm9vYmFy");

    const second = memo(render);
    expect(second.pending).toBeNull();
    expect(second.base64).toBe("Zm9vYmFy");
    expect(second.revision).toBe(first.revision);
    expect(encodeCalls).toBe(1);
  });

  test("gives each budget its own slot", async () => {
    // One slot for both would let a widget-sized encode reach the island, which
    // is not a larger avatar but an activity that never starts.
    const render = source();

    const island = memo(render);
    const widget = memo(render, WIDGET_BUDGET);
    await Promise.all([island.pending, widget.pending]);

    expect(encodeCalls).toBe(2);
    expect(widget.revision).not.toBe(island.revision);
    // And the island's slot survived the widget's, so neither evicts the other.
    expect(memo(render).revision).toBe(island.revision);
    expect(encodeCalls).toBe(2);
  });

  test("a new avatar is a new encode with an identity of its own", async () => {
    const first = memo(source());
    await first.pending;
    const second = memo(source());
    await second.pending;

    expect(encodeCalls).toBe(2);
    expect(second.revision).not.toBe(first.revision);
  });

  test("caches an avatar that fits no rung, which is a fact about the source", async () => {
    encodeOutcome = "nothing-fits";
    const render = source();

    expect(await memo(render).pending).toBeNull();
    expect(memo(render).base64).toBeNull();
    expect(encodeCalls).toBe(1);
  });

  test("never reaches the encoder for an assistant with no avatar", () => {
    const render: AvatarRender = { kind: "none" };

    const result = memo(render);

    // Settled on the spot, so a caller with nothing to draw stays synchronous.
    expect(result.pending).toBeNull();
    expect(result.base64).toBeNull();
    expect(encodeCalls).toBe(0);
  });

  test("retries an encode that threw instead of caching the failure", async () => {
    // The encoder failing (a canvas the shell would not hand over, a blob URL
    // revoked mid-draw) is transient, and cached it would leave every later
    // payload in the session avatar-less.
    encodeOutcome = "throws";
    const render = source();

    const failed = memo(render);
    // Resolved rather than rejected: a surface is worth more than the face on
    // it, so callers get an avatar-less payload rather than an error.
    expect(await failed.pending).toBeNull();

    encodeOutcome = "bytes";
    const retried = memo(render);
    expect(await retried.pending).toBe("Zm9vYmFy");
    expect(encodeCalls).toBe(2);
    // A fresh identity, so a caller keying a payload on the avatar can tell the
    // retry apart from the attempt that carried nothing.
    expect(retried.revision).not.toBe(failed.revision);
  });

  /**
   * The two halves meeting. The cases above stub the encoder, so they pin the
   * memo's rule and nothing else; the memo's rule is only worth as much as the
   * encoder's classification of what happened, so these run the REAL ladder
   * over the stub rasterizer at the top of this file.
   */
  const realMemo = (render: AvatarRender) =>
    memoizedAvatarEncode(render, ISLAND_AVATAR_MAX_BYTES, (r, maxBytes) =>
      encodeAvatarForIsland(r, maxBytes, rasterize as never),
    );

  test("drops the slot when the rasterizer fails, so the next read draws again", async () => {
    // The whole point of the classification: one transient canvas failure used
    // to resolve null, which the memo cached, and the session went avatar-less
    // from there.
    const render = source();
    throwOnDraw = true;

    const failed = realMemo(render);
    // Still resolved rather than rejected at the caller: the payload goes out
    // without a face rather than not at all.
    expect(await failed.pending).toBeNull();
    expect(attempts).toHaveLength(1);

    throwOnDraw = false;
    byteSizes["128:image/png"] = 900;
    const retried = realMemo(render);
    expect(await retried.pending).not.toBeNull();
    expect(retried.revision).not.toBe(failed.revision);
  });

  test("keeps the slot for an avatar that fits no rung, which is not a failure", async () => {
    const render = source();
    for (const size of [128, 96, 64, 48, 40, 32]) {
      byteSizes[`${size}:image/png`] = 99000;
    }
    byteSizes["64:image/jpeg"] = 99000;
    byteSizes["48:image/jpeg"] = 99000;

    expect(await realMemo(render).pending).toBeNull();
    expect(attempts).toHaveLength(8);

    const cached = realMemo(render);
    expect(cached.pending).toBeNull();
    expect(cached.base64).toBeNull();
    // No second walk of the ladder: the verdict is a fact about the source.
    expect(attempts).toHaveLength(8);
  });
});
