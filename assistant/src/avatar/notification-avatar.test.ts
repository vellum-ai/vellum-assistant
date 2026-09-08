/**
 * Tests for renderNotificationAvatarPng.
 *
 * Rendering routes through the native @resvg/resvg-js binding, so the cases
 * that need a real raster are gated on `isResvgAvailable()` and the suite
 * stays deterministic on an install that skipped the optional dependency.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import sharp from "sharp";

import { renderNotificationAvatarPng } from "./notification-avatar.js";
import { renderCharacterPng } from "./png-renderer.js";
import {
  __resetResvgCacheForTests,
  __setResvgCacheForTests,
  isResvgAvailable,
} from "./resvg-lazy.js";

/** The render cases need the native binding; without it there is nothing to assert. */
const nativeTest = test.if(isResvgAvailable());

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

  const writeUpload = async (format: "png" | "webp", accent: Accent) => {
    const image = sharp({
      create: {
        width: 64,
        height: 64,
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
      expect(image.at(DISC_SAMPLE.x, DISC_SAMPLE.y)).toEqual({
        ...FALLBACK_DISC,
        a: 255,
      });
      expect(image.at(128, 128)).toEqual({ r: 0x20, g: 0x60, b: 0xc0, a: 255 });
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  nativeTest(
    "returns null for an upload resvg cannot decode",
    async () => {
      await writeUpload("webp", null);

      expect(await renderNotificationAvatarPng()).toBeNull();
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

  nativeTest(
    "returns null when the native rasterizer is unavailable",
    async () => {
      writeCharacter(null);
      __setResvgCacheForTests({
        available: false,
        error: new Error("Cannot require module @resvg/resvg-js-darwin-x64"),
      });

      expect(await renderNotificationAvatarPng()).toBeNull();
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );
});
