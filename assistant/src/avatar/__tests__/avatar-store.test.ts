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
 * `getAvatarDir()` resolves live. Per the test-isolation rule in
 * assistant/AGENTS.md, this file imports ONLY the module under test
 * (`avatar-store`); state is asserted by reading `avatar.json` and the artifact
 * files directly off the per-test workspace dir via `node:fs`.
 *
 * `setCharacter` routes through the native @resvg/resvg-js renderer. Rather than
 * stub that native path (which would require importing production machinery), we
 * branch on the store's documented return value: when the binding is available
 * the success path is asserted, and when it is not the `native_unavailable`
 * failure contract is asserted instead — so the suite passes deterministically
 * whether or not the native binding is installed in the test environment.
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

import { clearAvatar, setCharacter, setImage } from "../avatar-store.js";

// A valid trait triple drawn from the real component set.
const VALID_TRAITS = { bodyShape: "blob", eyeStyle: "curious", color: "green" };

const IMAGE_FILENAME = "avatar-image.png";
const TRAITS_FILENAME = "character-traits.json";
const ASCII_FILENAME = "character-ascii.txt";
const MANIFEST_FILENAME = "avatar.json";
const NATIVE_RENDER_TEST_TIMEOUT_MS = 15_000;

interface ManifestShape {
  kind: string;
  traits: Record<string, unknown> | null;
  source: string | null;
  image: { updatedAt: string; etag: string } | null;
}

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
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const path = (name: string) => join(avatarDir, name);

  /** Reads and parses the on-disk manifest, or returns null when absent. */
  const readManifestFile = (): ManifestShape | null => {
    const manifestPath = path(MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestShape;
  };

  describe("setCharacter", () => {
    test(
      "writes traits + PNG and a character manifest when render succeeds",
      () => {
        const result = setCharacter(VALID_TRAITS);

        // The native @resvg/resvg-js binding may be absent in this environment.
        // When it is, the store returns `native_unavailable` and writes nothing —
        // we assert that contract instead of the success path so the suite is
        // deterministic either way.
        if (!result.ok) {
          expect(result.reason).toBe("native_unavailable");
          expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
          expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
          expect(existsSync(path(MANIFEST_FILENAME))).toBe(false);
          return;
        }

        expect(existsSync(path(TRAITS_FILENAME))).toBe(true);
        expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
        expect(
          JSON.parse(readFileSync(path(TRAITS_FILENAME), "utf-8")),
        ).toEqual(VALID_TRAITS);

        const manifest = readManifestFile();
        expect(manifest).not.toBeNull();
        expect(manifest!.kind).toBe("character");
        expect(manifest!.traits).toEqual(VALID_TRAITS);
        expect(manifest!.source).toBe("builder");
        expect(manifest!.image).not.toBeNull();
        expect(manifest!.image!.etag).toMatch(/^[0-9a-f]{16}$/);
      },
      NATIVE_RENDER_TEST_TIMEOUT_MS,
    );

    test("propagates invalid_traits without writing a manifest", () => {
      const result = setCharacter({ bodyShape: "", eyeStyle: "", color: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_traits");
      expect(existsSync(path(MANIFEST_FILENAME))).toBe(false);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
    });
  });

  describe("setImage", () => {
    test("writes the PNG and an image manifest", () => {
      setImage(Buffer.from("fake png bytes"), "upload");

      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(readFileSync(path(IMAGE_FILENAME)).toString()).toBe(
        "fake png bytes",
      );

      const manifest = readManifestFile();
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
      expect(readManifestFile()!.kind).toBe("image");
    });

    test("is idempotent across repeated calls", () => {
      setImage(Buffer.from("v1"), "upload");
      setImage(Buffer.from("v2"), "upload");

      expect(readFileSync(path(IMAGE_FILENAME)).toString()).toBe("v2");
      expect(readManifestFile()!.kind).toBe("image");
    });
  });

  describe("clearAvatar", () => {
    test("removes all artifacts AND the manifest (none == absence)", () => {
      writeFileSync(path(IMAGE_FILENAME), Buffer.from("png"));
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      clearAvatar();

      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);
      // "No avatar" is represented by the absence of avatar.json, so a later
      // legacy sidecar write isn't shadowed by a stale `none` manifest.
      expect(readManifestFile()).toBeNull();
    });

    test("is idempotent when nothing exists", () => {
      clearAvatar();
      clearAvatar();
      expect(readManifestFile()).toBeNull();
    });
  });
});
