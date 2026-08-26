/**
 * Tests for ensureAvatarRaster and ensureAvatarRasterPath.
 *
 * Character re-render routes through the native @resvg/resvg-js binding. As in
 * avatar-store.test.ts, the re-render case branches on `isResvgAvailable()` so
 * the suite is deterministic whether or not the binding is installed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ensureAvatarRaster,
  ensureAvatarRasterPath,
} from "../ensure-raster.js";
import {
  __resetResvgCacheForTests,
  __setResvgCacheForTests,
  isResvgAvailable,
} from "../resvg-lazy.js";

const VALID_TRAITS = { bodyShape: "blob", eyeStyle: "curious", color: "green" };

const IMAGE_FILENAME = "avatar-image.png";
const MANIFEST_FILENAME = "avatar.json";
const NATIVE_RENDER_TEST_TIMEOUT_MS = 15_000;

const FAKE_PNG = Buffer.from("not-really-a-png");

describe("ensureAvatarRaster", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ensure-raster-test-"));
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

  test("returns null for kind none", async () => {
    writeManifestFile({
      kind: "none",
      traits: null,
      source: null,
      image: null,
    });
    expect(await ensureAvatarRaster()).toBeNull();
  });

  test("returns null with no manifest and no legacy files", async () => {
    expect(await ensureAvatarRaster()).toBeNull();
  });

  test("returns the existing PNG bytes for an image avatar", async () => {
    writeFileSync(join(avatarDir, IMAGE_FILENAME), FAKE_PNG);
    writeManifestFile({
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "0123456789abcdef" },
    });
    const raster = await ensureAvatarRaster();
    expect(raster).not.toBeNull();
    expect(raster!.equals(FAKE_PNG)).toBe(true);
  });

  test("returns the existing PNG for a character without re-rendering", async () => {
    writeFileSync(join(avatarDir, IMAGE_FILENAME), FAKE_PNG);
    writeManifestFile({
      kind: "character",
      traits: VALID_TRAITS,
      source: "builder",
      image: null,
    });
    // Force the unavailable path: a re-render attempt would return null.
    __setResvgCacheForTests({ available: false, error: new Error("nope") });
    const raster = await ensureAvatarRaster();
    expect(raster).not.toBeNull();
    expect(raster!.equals(FAKE_PNG)).toBe(true);
  });

  test("returns null for a symlinked PNG but still reports its path", async () => {
    const outside = join(workspaceDir, "outside.png");
    writeFileSync(outside, FAKE_PNG);
    symlinkSync(outside, join(avatarDir, IMAGE_FILENAME));
    writeManifestFile({
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "0123456789abcdef" },
    });
    expect(await ensureAvatarRasterPath()).toBe(
      join(avatarDir, IMAGE_FILENAME),
    );
    expect(await ensureAvatarRaster()).toBeNull();
  });

  test("returns null when the avatar dir is a symlink to another workspace", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "foreign-avatar-"));
    writeFileSync(join(foreign, IMAGE_FILENAME), FAKE_PNG);
    rmSync(avatarDir, { recursive: true, force: true });
    symlinkSync(foreign, avatarDir);
    writeManifestFile({
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "0123456789abcdef" },
    });
    expect(await ensureAvatarRaster()).toBeNull();
    rmSync(foreign, { recursive: true, force: true });
  });

  test("returns null for an image avatar whose PNG is missing", async () => {
    writeManifestFile({
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "0123456789abcdef" },
    });
    expect(await ensureAvatarRaster()).toBeNull();
    expect(existsSync(join(avatarDir, IMAGE_FILENAME))).toBe(false);
  });

  test("returns null for a character when resvg is unavailable", async () => {
    writeManifestFile({
      kind: "character",
      traits: VALID_TRAITS,
      source: "builder",
      image: null,
    });
    __setResvgCacheForTests({ available: false, error: new Error("nope") });
    expect(await ensureAvatarRaster()).toBeNull();
    expect(existsSync(join(avatarDir, IMAGE_FILENAME))).toBe(false);
  });

  test(
    "re-renders a character whose PNG is missing",
    async () => {
      writeManifestFile({
        kind: "character",
        traits: VALID_TRAITS,
        source: "builder",
        image: null,
      });
      const raster = await ensureAvatarRaster();
      if (!isResvgAvailable()) {
        expect(raster).toBeNull();
        return;
      }
      expect(raster).not.toBeNull();
      expect(raster!.length).toBeGreaterThan(0);
      // PNG magic bytes
      expect(
        raster!.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      ).toBe(true);
      expect(existsSync(join(avatarDir, IMAGE_FILENAME))).toBe(true);
    },
    NATIVE_RENDER_TEST_TIMEOUT_MS,
  );

  test("accepts an explicit state instead of reading the manifest", async () => {
    writeFileSync(join(avatarDir, IMAGE_FILENAME), FAKE_PNG);
    // No manifest on disk; explicit `none` wins over the legacy PNG.
    expect(
      await ensureAvatarRaster({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      }),
    ).toBeNull();
  });

  describe("ensureAvatarRasterPath", () => {
    test("returns null for kind none", async () => {
      writeFileSync(join(avatarDir, IMAGE_FILENAME), FAKE_PNG);
      writeManifestFile({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      });
      expect(await ensureAvatarRasterPath()).toBeNull();
    });

    test("returns the path of an existing PNG without reading it", async () => {
      writeFileSync(join(avatarDir, IMAGE_FILENAME), FAKE_PNG);
      writeManifestFile({
        kind: "image",
        traits: null,
        source: "upload",
        image: {
          updatedAt: new Date().toISOString(),
          etag: "0123456789abcdef",
        },
      });
      expect(await ensureAvatarRasterPath()).toBe(
        join(avatarDir, IMAGE_FILENAME),
      );
    });

    test("returns null for a symlinked PNG but still reports its path", async () => {
      const outside = join(workspaceDir, "outside.png");
      writeFileSync(outside, FAKE_PNG);
      symlinkSync(outside, join(avatarDir, IMAGE_FILENAME));
      writeManifestFile({
        kind: "image",
        traits: null,
        source: "upload",
        image: {
          updatedAt: new Date().toISOString(),
          etag: "0123456789abcdef",
        },
      });
      expect(await ensureAvatarRasterPath()).toBe(
        join(avatarDir, IMAGE_FILENAME),
      );
      expect(await ensureAvatarRaster()).toBeNull();
    });

    test("returns null for an image avatar whose PNG is missing", async () => {
      writeManifestFile({
        kind: "image",
        traits: null,
        source: "upload",
        image: {
          updatedAt: new Date().toISOString(),
          etag: "0123456789abcdef",
        },
      });
      expect(await ensureAvatarRasterPath()).toBeNull();
    });

    test("returns null for a character when resvg is unavailable", async () => {
      writeManifestFile({
        kind: "character",
        traits: VALID_TRAITS,
        source: "builder",
        image: null,
      });
      __setResvgCacheForTests({ available: false, error: new Error("nope") });
      expect(await ensureAvatarRasterPath()).toBeNull();
      expect(existsSync(join(avatarDir, IMAGE_FILENAME))).toBe(false);
    });

    test(
      "re-renders a character whose PNG is missing and returns its path",
      async () => {
        writeManifestFile({
          kind: "character",
          traits: VALID_TRAITS,
          source: "builder",
          image: null,
        });
        const path = await ensureAvatarRasterPath();
        if (!isResvgAvailable()) {
          expect(path).toBeNull();
          return;
        }
        expect(path).toBe(join(avatarDir, IMAGE_FILENAME));
        expect(existsSync(path!)).toBe(true);
      },
      NATIVE_RENDER_TEST_TIMEOUT_MS,
    );
  });
});
