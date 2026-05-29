/**
 * Tests for the avatar store — atomic artifact + manifest mutations.
 *
 * Each operation must leave `avatar.json` consistent with the on-disk
 * artifacts:
 *   - setCharacter  → traits.json + PNG (+ ASCII) on disk, `character` manifest
 *   - setImage      → PNG on disk, character sidecars removed, `image` manifest
 *   - clearAvatar   → everything removed, `none` manifest
 *
 * The avatar directory is controlled per-test via VELLUM_WORKSPACE_DIR, which
 * `getAvatarDir()` resolves live. `setCharacter` routes through the native
 * @resvg/resvg-js renderer; we drive that branch deterministically with the
 * resvg-lazy test hooks so the suite passes whether or not the native binding
 * is installed in the test environment.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readManifest } from "../avatar-manifest.js";
import { clearAvatar, setCharacter, setImage } from "../avatar-store.js";
import {
  __resetResvgCacheForTests,
  __setResvgCacheForTests,
  isResvgAvailable,
} from "../resvg-lazy.js";

// A valid trait triple drawn from the real component set.
const VALID_TRAITS = { bodyShape: "blob", eyeStyle: "curious", color: "green" };

const IMAGE_FILENAME = "avatar-image.png";
const TRAITS_FILENAME = "character-traits.json";
const ASCII_FILENAME = "character-ascii.txt";
const MANIFEST_FILENAME = "avatar.json";

describe("avatar-store", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-store-test-"));
    // getAvatarDir() === <workspace>/data/avatar
    avatarDir = join(workspaceDir, "data", "avatar");
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    // Pre-create the avatar dir so tests that seed legacy artifacts can write
    // into it before the store's own mkdir runs.
    mkdirSync(avatarDir, { recursive: true });
    __resetResvgCacheForTests();
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    __resetResvgCacheForTests();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const path = (name: string) => join(avatarDir, name);

  describe("setCharacter", () => {
    test("writes traits + PNG and a character manifest when render succeeds", () => {
      // Only meaningful when the native renderer is actually available.
      if (!isResvgAvailable()) return;

      const result = setCharacter(VALID_TRAITS);
      expect(result.ok).toBe(true);

      expect(existsSync(path(TRAITS_FILENAME))).toBe(true);
      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(JSON.parse(readFileSync(path(TRAITS_FILENAME), "utf-8"))).toEqual(
        VALID_TRAITS,
      );

      const manifest = readManifest(avatarDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.kind).toBe("character");
      expect(manifest!.traits).toEqual(VALID_TRAITS);
      expect(manifest!.source).toBe("builder");
      expect(manifest!.image).not.toBeNull();
      expect(manifest!.image!.etag).toMatch(/^[0-9a-f]{16}$/);
    });

    test("returns the underlying result and writes no manifest when native renderer is unavailable", () => {
      __setResvgCacheForTests({
        available: false,
        error: new Error("native unavailable"),
      });

      const result = setCharacter(VALID_TRAITS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("native_unavailable");

      // No artifacts and no manifest should have been written.
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
      expect(existsSync(path(MANIFEST_FILENAME))).toBe(false);
    });

    test("propagates invalid_traits without writing a manifest", () => {
      const result = setCharacter({ bodyShape: "", eyeStyle: "", color: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_traits");
      expect(existsSync(path(MANIFEST_FILENAME))).toBe(false);
    });
  });

  describe("setImage", () => {
    test("writes the PNG and an image manifest", () => {
      setImage(Buffer.from("fake png bytes"), "upload");

      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(readFileSync(path(IMAGE_FILENAME)).toString()).toBe(
        "fake png bytes",
      );

      const manifest = readManifest(avatarDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.kind).toBe("image");
      expect(manifest!.traits).toBeNull();
      expect(manifest!.source).toBe("upload");
      expect(manifest!.image).not.toBeNull();
      expect(manifest!.image!.etag).toMatch(/^[0-9a-f]{16}$/);
      expect(manifest!.image!.updatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    test("removes stale character sidecars on transition", () => {
      // Seed legacy character artifacts.
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      setImage(Buffer.from("png"), "ai");

      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);
      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(readManifest(avatarDir)!.kind).toBe("image");
    });

    test("is idempotent across repeated calls", () => {
      setImage(Buffer.from("v1"), "upload");
      setImage(Buffer.from("v2"), "upload");

      expect(readFileSync(path(IMAGE_FILENAME)).toString()).toBe("v2");
      expect(readManifest(avatarDir)!.kind).toBe("image");
    });
  });

  describe("clearAvatar", () => {
    test("removes all artifacts and writes a none manifest", () => {
      writeFileSync(path(IMAGE_FILENAME), Buffer.from("png"));
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      clearAvatar();

      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);
      expect(readManifest(avatarDir)).toEqual({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      });
    });

    test("is idempotent when nothing exists", () => {
      clearAvatar();
      clearAvatar();
      expect(readManifest(avatarDir)).toEqual({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      });
    });
  });
});
