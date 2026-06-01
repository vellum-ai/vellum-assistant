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

import { seedAvatarManifestMigration } from "../094-seed-avatar-manifest.js";

const VALID_TRAITS = {
  bodyShape: "round",
  eyeStyle: "wide",
  color: "#123456",
};

let workspaceDir: string;
let avatarDir: string;
let manifestPath: string;

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "seed-avatar-manifest-"));
  avatarDir = join(workspaceDir, "data", "avatar");
  mkdirSync(avatarDir, { recursive: true });
  manifestPath = join(avatarDir, "avatar.json");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("094-seed-avatar-manifest", () => {
  test("has a unique, expected id", () => {
    expect(seedAvatarManifestMigration.id).toBe("094-seed-avatar-manifest");
  });

  test("traits only → character", () => {
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );

    seedAvatarManifestMigration.run(workspaceDir);

    const manifest = readManifest();
    expect(manifest.kind).toBe("character");
    expect(manifest.traits).toEqual(VALID_TRAITS);
    expect(manifest.image).toBeNull();
  });

  test("image only → image", () => {
    writeFileSync(join(avatarDir, "avatar-image.png"), "fake-png-bytes");

    seedAvatarManifestMigration.run(workspaceDir);

    const manifest = readManifest();
    expect(manifest.kind).toBe("image");
    expect(manifest.traits).toBeNull();
    const image = manifest.image as Record<string, unknown>;
    expect(typeof image.updatedAt).toBe("string");
    expect(typeof image.etag).toBe("string");
  });

  test("both present → character (traits-first)", () => {
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );
    writeFileSync(join(avatarDir, "avatar-image.png"), "fake-png-bytes");

    seedAvatarManifestMigration.run(workspaceDir);

    const manifest = readManifest();
    expect(manifest.kind).toBe("character");
    expect(manifest.traits).toEqual(VALID_TRAITS);
    expect(manifest.image).toBeNull();
  });

  test("neither present → no manifest written (none == absence of avatar.json)", () => {
    seedAvatarManifestMigration.run(workspaceDir);

    // An avatar-less workspace must stay manifest-less so a later legacy sidecar
    // write is still picked up by the read-time self-heal.
    expect(existsSync(manifestPath)).toBe(false);
  });

  test("re-run is a no-op (does not overwrite an existing manifest)", () => {
    // Seed an image-derived manifest first.
    writeFileSync(join(avatarDir, "avatar-image.png"), "fake-png-bytes");
    seedAvatarManifestMigration.run(workspaceDir);
    const first = readFileSync(manifestPath, "utf-8");

    // Now add traits — a fresh derivation would flip to character, but the
    // migration must leave the existing manifest untouched.
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );
    seedAvatarManifestMigration.run(workspaceDir);

    expect(readFileSync(manifestPath, "utf-8")).toBe(first);
    expect((JSON.parse(first) as Record<string, unknown>).kind).toBe("image");
  });

  test("down() removes only avatar.json (legacy files remain)", () => {
    const traitsPath = join(avatarDir, "character-traits.json");
    const imagePath = join(avatarDir, "avatar-image.png");
    writeFileSync(traitsPath, JSON.stringify(VALID_TRAITS));
    writeFileSync(imagePath, "fake-png-bytes");

    seedAvatarManifestMigration.run(workspaceDir);
    expect(existsSync(manifestPath)).toBe(true);

    seedAvatarManifestMigration.down(workspaceDir);

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(traitsPath)).toBe(true);
    expect(existsSync(imagePath)).toBe(true);
  });

  test("down() is idempotent when no manifest exists", () => {
    expect(() => seedAvatarManifestMigration.down(workspaceDir)).not.toThrow();
    expect(existsSync(manifestPath)).toBe(false);
  });
});
