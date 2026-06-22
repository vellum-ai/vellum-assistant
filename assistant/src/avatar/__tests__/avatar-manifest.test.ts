import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type AvatarState,
  deriveStateFromLegacyFiles,
  readManifest,
  writeManifest,
} from "../avatar-manifest.js";

const VALID_TRAITS = { bodyShape: "round", eyeStyle: "happy", color: "blue" };

describe("avatar-manifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "avatar-manifest-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("readManifest / writeManifest", () => {
    test("round-trips a written manifest", () => {
      const state: AvatarState = {
        kind: "character",
        traits: VALID_TRAITS,
        source: "builder",
        image: null,
      };
      writeManifest(state, dir);
      expect(readManifest(dir)).toEqual(state);
    });

    test("round-trips an image manifest", () => {
      const state: AvatarState = {
        kind: "image",
        traits: null,
        source: "upload",
        image: { updatedAt: "2024-01-01T00:00:00.000Z", etag: "abc123" },
      };
      writeManifest(state, dir);
      expect(readManifest(dir)).toEqual(state);
    });

    test("returns null when manifest is missing", () => {
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when manifest is corrupt JSON", () => {
      writeFileSync(join(dir, "avatar.json"), "{ not json");
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is invalid", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "bogus",
          traits: null,
          source: null,
          image: null,
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is missing", () => {
      writeFileSync(join(dir, "avatar.json"), JSON.stringify({ traits: null }));
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is character but traits are null", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "character",
          traits: null,
          source: null,
          image: null,
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is character but traits are missing", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({ kind: "character" }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is character but traits are incomplete", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "character",
          traits: { bodyShape: "round" },
          source: null,
          image: null,
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is image but image meta is null", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "image",
          traits: null,
          source: null,
          image: null,
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is image but image meta is missing", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({ kind: "image" }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is image but etag is empty", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "image",
          traits: null,
          source: null,
          image: { updatedAt: "2024-01-01T00:00:00.000Z", etag: "" },
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns null when kind is image but updatedAt is missing", () => {
      writeFileSync(
        join(dir, "avatar.json"),
        JSON.stringify({
          kind: "image",
          traits: null,
          source: null,
          image: { etag: "abc123" },
        }),
      );
      expect(readManifest(dir)).toBeNull();
    });

    test("returns the manifest when kind is none (no payload required)", () => {
      const state: AvatarState = {
        kind: "none",
        traits: null,
        source: null,
        image: null,
      };
      writeFileSync(join(dir, "avatar.json"), JSON.stringify({ kind: "none" }));
      expect(readManifest(dir)).toEqual(state);
    });
  });

  describe("deriveStateFromLegacyFiles", () => {
    test("traits-only → character", () => {
      writeFileSync(
        join(dir, "character-traits.json"),
        JSON.stringify(VALID_TRAITS),
      );
      const state = deriveStateFromLegacyFiles(dir);
      expect(state.kind).toBe("character");
      expect(state.traits).toEqual(VALID_TRAITS);
      expect(state.source).toBeNull();
      expect(state.image).toBeNull();
    });

    test("image-only → image with computed etag and updatedAt", () => {
      writeFileSync(join(dir, "avatar-image.png"), Buffer.from("fake png"));
      const state = deriveStateFromLegacyFiles(dir);
      expect(state.kind).toBe("image");
      expect(state.traits).toBeNull();
      expect(state.source).toBeNull();
      expect(state.image?.etag).toMatch(/^[0-9a-f]{16}$/);
      expect(state.image?.updatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    test("both present → character (traits-first, ignores PNG mtime)", () => {
      // Write traits first, then PNG so the PNG is strictly newer — mirrors
      // how the builder writes files. Traits-first must still win.
      writeFileSync(
        join(dir, "character-traits.json"),
        JSON.stringify(VALID_TRAITS),
      );
      writeFileSync(join(dir, "avatar-image.png"), Buffer.from("fake png"));
      const state = deriveStateFromLegacyFiles(dir);
      expect(state.kind).toBe("character");
      expect(state.traits).toEqual(VALID_TRAITS);
      expect(state.image).toBeNull();
    });

    test("corrupt traits json + image present → image", () => {
      writeFileSync(join(dir, "character-traits.json"), "{ broken");
      writeFileSync(join(dir, "avatar-image.png"), Buffer.from("fake png"));
      const state = deriveStateFromLegacyFiles(dir);
      expect(state.kind).toBe("image");
      expect(state.image).not.toBeNull();
    });

    test("incomplete traits (missing fields) + image present → image", () => {
      writeFileSync(
        join(dir, "character-traits.json"),
        JSON.stringify({ bodyShape: "round" }),
      );
      writeFileSync(join(dir, "avatar-image.png"), Buffer.from("fake png"));
      const state = deriveStateFromLegacyFiles(dir);
      expect(state.kind).toBe("image");
    });

    test("neither → none", () => {
      const state = deriveStateFromLegacyFiles(dir);
      expect(state).toEqual({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      });
    });
  });
});
