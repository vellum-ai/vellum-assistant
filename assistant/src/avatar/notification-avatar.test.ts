/**
 * Tests for renderNotificationAvatarPng.
 *
 * Rendering routes through the native @resvg/resvg-js binding, so the cases
 * that need a real raster are gated on `isResvgAvailable()` and the suite
 * stays deterministic on an install that skipped the optional dependency.
 *
 * The output disc is inscribed in the square: the corners are transparent on
 * purpose, since every consumer circle-crops the icon. So the pixel cases
 * assert transparent corners alongside an opaque disc and centre.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NOTIFICATION_AVATAR_MAX_BYTES } from "@vellumai/avatar-manifest/notification-avatar";
import sharp from "sharp";

import {
  __resetSharpCacheForTests,
  __setSharpCacheForTests,
  canRenderNotificationAvatar,
  renderNotificationAvatarPng,
} from "./notification-avatar.js";
import { renderCharacterPng } from "./png-renderer.js";
import {
  __resetResvgCacheForTests,
  __setResvgCacheForTests,
  isResvgAvailable,
} from "./resvg-lazy.js";

/**
 * The render cases need the native binding; without it there is nothing to
 * assert. The check runs inside the body rather than at module scope because
 * `mock.module` is process-global and the suite runs by directory: a sibling
 * file's fake for `./resvg-lazy.js` would otherwise decide, at import time,
 * that this whole file has nothing to run.
 */
function nativeTest(
  name: string,
  body: () => Promise<void>,
  timeout?: number,
): void {
  test(
    name,
    async () => {
      if (!isResvgAvailable()) {
        return;
      }
      await body();
    },
    timeout,
  );
}

const IMAGE_FILENAME = "avatar-image.png";
const MANIFEST_FILENAME = "avatar.json";
const NATIVE_RENDER_TEST_TIMEOUT_MS = 15_000;

const TRAITS = { bodyShape: "blob", eyeStyle: "curious", color: "green" };
/** The palette green (#4C9B50) mixed 14% into white. */
const GREEN_DISC = { r: 0xe6, g: 0xf1, b: 0xe7 };
/** #E9642F mixed 14% into white. */
const ORANGE_DISC = { r: 0xfc, g: 0xe9, b: 0xe2 };
/** The neutral disc every accent-less avatar wears. */
const FALLBACK_DISC = { r: 0xec, g: 0xef, b: 0xea };

/** On the disc and clear of the inset avatar square, which starts at y = 28.16. */
const DISC_SAMPLE = { x: 128, y: 8 };
/** Outside the inscribed disc, where the render leaves nothing at all. */
const CORNER = { x: 0, y: 0 };

type Accent = { hex: string; source: string } | null;

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

async function pixels(png: Buffer): Promise<{
  width: number;
  height: number;
  at: (x: number, y: number) => Pixel;
}> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
    },
  };
}

describe("renderNotificationAvatarPng", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "notification-avatar-test-"));
    avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    __resetResvgCacheForTests();
    __resetSharpCacheForTests();
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const writeManifestFile = (manifest: Record<string, unknown>) => {
    writeFileSync(join(avatarDir, MANIFEST_FILENAME), JSON.stringify(manifest));
  };

  const writeUploadManifest = (accent: Accent) => {
    writeManifestFile({
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "0123456789abcdef" },
      accent,
    });
  };

  const writeCharacter = (accent: Accent) => {
    writeFileSync(
      join(avatarDir, IMAGE_FILENAME),
      renderCharacterPng(TRAITS.bodyShape, TRAITS.eyeStyle, TRAITS.color),
    );
    writeManifestFile({
      kind: "character",
      traits: TRAITS,
      source: "builder",
      image: null,
      accent,
    });
  };

  /**
   * A 1024x1024 wall of per-pixel noise: the worst case a photographic upload
   * puts in front of the encoder, and the only input that reaches the cap.
   */
  const writeNoisyUpload = async () => {
    const size = 1024;
    const raw = Buffer.allocUnsafe(size * size * 3);
    let seed = 0x12345678;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (seed >> 16) & 0xff;
    }
    const bytes = await sharp(raw, {
      raw: { width: size, height: size, channels: 3 },
    })
      .png()
      .toBuffer();
    writeFileSync(join(avatarDir, IMAGE_FILENAME), bytes);
    writeUploadManifest(null);
  };

  const writeUpload = async (
    format: "png" | "webp",
    accent: Accent,
    { width = 64, height = 64 } = {},
  ) => {
    const image = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0x20, g: 0x60, b: 0xc0, alpha: 1 },
      },
    });
    const bytes =
      format === "webp"
        ? await image.webp().toBuffer()
        : await image.png().toBuffer();
    writeFileSync(join(avatarDir, IMAGE_FILENAME), bytes);
    writeUploadManifest(accent);
  };

  nativeTest(
    "renders a character on its palette disc",
    async () => {
      writeCharacter(null);

      const png = await renderNotificationAvatarPng();
      expect(png).not.toBeNull();
      expect(png!.subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(png!.length).toBeLessThan(64 * 1024);

      const image = await pixels(png!);
      expect(image.width).toBe(256);
      expect(image.height).toBe(256);
      expect(image.at(CORNER.x, CORNER.y).a).toBe(0);
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...GREEN_DISC,
        a: 255,
      });
      expect(image.at(128, 128).a).toBe(255);
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "prefers the manifest accent over the palette colour",
    async () => {
      writeCharacter({ hex: "#e9642f", source: "custom" });

      const image = await pixels((await renderNotificationAvatarPng())!);
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...ORANGE_DISC,
        a: 255,
      });
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "renders an uploaded image on the neutral disc when it has no accent",
    async () => {
      await writeUpload("png", null);

      const png = await renderNotificationAvatarPng();
      expect(png).not.toBeNull();

      const image = await pixels(png!);
      expect(image.width).toBe(256);
      expect(image.height).toBe(256);
      expect(image.at(CORNER.x, CORNER.y).a).toBe(0);
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...FALLBACK_DISC,
        a: 255,
      });
      expect(image.at(128, 128)).toEqual({ r: 0x20, g: 0x60, b: 0xc0, a: 255 });
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "cover-crops a wide upload and clips it to the disc",
    async () => {
      // 4:1, so a letterboxing render would leave disc colour above and below
      // the avatar inside the inset square.
      await writeUpload("png", null, { width: 256, height: 64 });

      const image = await pixels((await renderNotificationAvatarPng())!);
      // Inside the inset square (which starts at 28.16) near its top edge:
      // filled by a cover-crop, disc colour by a letterbox.
      expect(image.at(128, 35)).toEqual({ r: 0x20, g: 0x60, b: 0xc0, a: 255 });
      // Inside the inset square but outside the disc, so only the clip can
      // keep the avatar out of it.
      expect(image.at(30, 30).a).toBe(0);
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "transcodes a WebP upload, which resvg cannot decode on its own",
    async () => {
      await writeUpload("webp", null);

      const png = await renderNotificationAvatarPng();
      expect(png).not.toBeNull();

      const image = await pixels(png!);
      expect(image.at(CORNER.x, CORNER.y).a).toBe(0);
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...FALLBACK_DISC,
        a: 255,
      });
      // WebP is lossy, so the transcode moves the flat fill by a channel step
      // or two; what matters is that the avatar is drawn at all.
      const centre = image.at(128, 128);
      expect(centre.a).toBe(255);
      for (const [actual, expected] of [
        [centre.r, 0x20],
        [centre.g, 0x60],
        [centre.b, 0xc0],
      ]) {
        expect(Math.abs(actual! - expected!)).toBeLessThanOrEqual(4);
      }
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  test("returns null for a raster in no image format at all", async () => {
    writeUploadManifest(null);

    expect(
      await renderNotificationAvatarPng(
        undefined,
        Buffer.from("not an image at all, just some bytes"),
      ),
    ).toBeNull();
  });

  nativeTest(
    "renders inside the square the push transports accept",
    async () => {
      writeCharacter(null);

      const png = (await renderNotificationAvatarPng())!;
      // The IHDR width and height, at fixed offsets past the 8-byte signature.
      // The platform's own ceiling is a square of at most 512 px and 128 KB.
      expect(png.readUInt32BE(16)).toBe(256);
      expect(png.readUInt32BE(20)).toBe(256);
      expect(png.length).toBeLessThanOrEqual(131072);
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "returns null for a WebP upload when sharp has no native binary",
    async () => {
      await writeUpload("webp", null);
      __setSharpCacheForTests(null);

      expect(await renderNotificationAvatarPng()).toBeNull();
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "keeps a photographic upload inside the byte cap or gives up",
    async () => {
      await writeNoisyUpload();

      const png = await renderNotificationAvatarPng();
      if (png === null) {
        return;
      }
      expect(png.length).toBeLessThanOrEqual(NOTIFICATION_AVATAR_MAX_BYTES);
      const image = await pixels(png);
      expect(image.width).toBe(256);
      expect(image.height).toBe(256);
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "renders the raster it is handed instead of resolving one",
    async () => {
      const raster = renderCharacterPng(
        TRAITS.bodyShape,
        TRAITS.eyeStyle,
        TRAITS.color,
      );
      writeManifestFile({
        kind: "character",
        traits: TRAITS,
        source: "builder",
        image: null,
        accent: null,
      });

      const png = await renderNotificationAvatarPng(undefined, raster);
      expect(png).not.toBeNull();
      const image = await pixels(png!);
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...GREEN_DISC,
        a: 255,
      });
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  test("returns null for kind none", async () => {
    expect(
      await renderNotificationAvatarPng({
        kind: "none",
        traits: null,
        source: null,
        image: null,
        accent: null,
      }),
    ).toBeNull();
  });

  test("returns null when there is no avatar raster", async () => {
    writeUploadManifest(null);

    expect(await renderNotificationAvatarPng()).toBeNull();
  });

  // Forces the cache rather than reading it, so this one holds without the
  // native binding installed.
  test("returns null when the native rasterizer is unavailable", async () => {
    writeCharacter(null);
    __setResvgCacheForTests({
      available: false,
      error: new Error("Cannot require module @resvg/resvg-js-darwin-x64"),
    });

    expect(await renderNotificationAvatarPng()).toBeNull();
  });
});

/**
 * The platform sync folds this answer into its dedup key, so it has to be
 * true exactly when a disc would come out, and it has to say so without
 * rendering one.
 */
describe("canRenderNotificationAvatar", () => {
  const webp = async () =>
    sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 0x20, g: 0x60, b: 0xc0, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();

  afterEach(() => {
    __resetResvgCacheForTests();
    __resetSharpCacheForTests();
  });

  nativeTest("says yes for a PNG resvg draws directly", async () => {
    expect(
      await canRenderNotificationAvatar(
        renderCharacterPng(TRAITS.bodyShape, TRAITS.eyeStyle, TRAITS.color),
      ),
    ).toBe(true);
  });

  nativeTest("says yes for a WebP, which sharp transcodes", async () => {
    expect(await canRenderNotificationAvatar(await webp())).toBe(true);
  });

  // The raster is drawn before the cache is forced, since drawing it needs the
  // same binding this case takes away.
  nativeTest("says no without the native rasterizer", async () => {
    const raster = renderCharacterPng(
      TRAITS.bodyShape,
      TRAITS.eyeStyle,
      TRAITS.color,
    );
    __setResvgCacheForTests({
      available: false,
      error: new Error("Cannot require module @resvg/resvg-js-darwin-x64"),
    });

    expect(await canRenderNotificationAvatar(raster)).toBe(false);
  });

  nativeTest("says no for bytes in no image format at all", async () => {
    expect(
      await canRenderNotificationAvatar(Buffer.from("just some bytes here")),
    ).toBe(false);
  });

  // The transcode is the only route a WebP has, so without the codec there is
  // no disc to promise, and the sync's key has to say so.
  nativeTest("says no for a WebP when sharp has no native binary", async () => {
    const bytes = await webp();
    __setSharpCacheForTests(null);

    expect(await canRenderNotificationAvatar(bytes)).toBe(false);
  });
});
