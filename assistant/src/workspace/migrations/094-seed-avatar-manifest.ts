import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("094-seed-avatar-manifest");

// Filenames are inlined to keep this migration self-contained (see AGENTS.md).
// They mirror the canonical constants in util/platform.ts and avatar-manifest.ts.
const TRAITS_FILENAME = "character-traits.json";
const AVATAR_IMAGE_FILENAME = "avatar-image.png";
const AVATAR_MANIFEST_FILENAME = "avatar.json";

type AvatarKind = "character" | "image" | "none";
type AvatarSource = "builder" | "upload" | "ai";

interface AvatarImageMeta {
  updatedAt: string;
  etag: string;
}

interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

interface AvatarState {
  kind: AvatarKind;
  traits: CharacterTraits | null;
  source: AvatarSource | null;
  image: AvatarImageMeta | null;
}

/** Narrows an unknown value to valid CharacterTraits (presence check only). */
function isValidTraits(value: unknown): value is CharacterTraits {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.bodyShape === "string" &&
    !!t.bodyShape &&
    typeof t.eyeStyle === "string" &&
    !!t.eyeStyle &&
    typeof t.color === "string" &&
    !!t.color
  );
}

/** Computes a stable etag for the avatar image from its size and mtime. */
function computeImageEtag(sizeBytes: number, mtimeMs: number): string {
  return createHash("sha256")
    .update(`${sizeBytes}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Derives avatar state from the legacy sidecar files (traits JSON + PNG).
 *
 * Inference is **traits-first**: whenever a valid `character-traits.json`
 * exists, the result is `character` regardless of whether a PNG is also
 * present. We deliberately do NOT compare mtimes to break the both-present
 * tie, because the builder writes the rendered PNG *after* the traits file, so
 * the PNG is always newer even when the character is the source of truth.
 *
 * Inlined from avatar-manifest.ts to keep this migration self-contained.
 */
function deriveStateFromLegacyFiles(avatarDir: string): AvatarState {
  const traitsPath = join(avatarDir, TRAITS_FILENAME);
  if (existsSync(traitsPath)) {
    try {
      const traits = JSON.parse(readFileSync(traitsPath, "utf-8")) as unknown;
      if (isValidTraits(traits)) {
        return { kind: "character", traits, source: null, image: null };
      }
    } catch (err) {
      log.warn(
        { err },
        "Corrupt character-traits.json — falling back to image/none",
      );
    }
  }

  const imagePath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  if (existsSync(imagePath)) {
    const stats = statSync(imagePath);
    return {
      kind: "image",
      traits: null,
      source: null,
      image: {
        updatedAt: new Date(stats.mtimeMs).toISOString(),
        etag: computeImageEtag(stats.size, stats.mtimeMs),
      },
    };
  }

  return { kind: "none", traits: null, source: null, image: null };
}

/**
 * Writes the avatar manifest atomically (tmp-write + rename), mirroring the
 * write pattern in avatar-manifest.ts. Inlined to keep this migration
 * self-contained.
 */
function writeManifest(state: AvatarState, avatarDir: string): void {
  mkdirSync(avatarDir, { recursive: true });
  const manifestPath = join(avatarDir, AVATAR_MANIFEST_FILENAME);
  const tmp = `${manifestPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, manifestPath);
}

export const seedAvatarManifestMigration: WorkspaceMigration = {
  id: "094-seed-avatar-manifest",
  description:
    "Seed avatar.json from legacy sidecar files (traits-first), backfilling existing workspaces",
  run(workspaceDir: string): void {
    const avatarDir = join(workspaceDir, "data", "avatar");
    const manifestPath = join(avatarDir, AVATAR_MANIFEST_FILENAME);

    // Idempotent: if a manifest already exists, leave it untouched.
    if (existsSync(manifestPath)) return;

    const state = deriveStateFromLegacyFiles(avatarDir);

    // Only seed a manifest for a *real* avatar (character/image). An avatar-less
    // workspace derives { kind: "none" }; we deliberately do NOT write that, so
    // the workspace stays manifest-less and the read-time self-heal can still
    // pick up a later legacy sidecar write (older clients / automation that set
    // an avatar via the generic workspace-file API) instead of being shadowed by
    // a stale `none` manifest. "No avatar" == absence of avatar.json everywhere.
    if (state.kind === "none") return;

    writeManifest(state, avatarDir);
  },
  down(workspaceDir: string): void {
    const avatarDir = join(workspaceDir, "data", "avatar");
    const manifestPath = join(avatarDir, AVATAR_MANIFEST_FILENAME);
    // Remove only the manifest; leave legacy files intact so the old
    // heuristic/fallback still works on rollback. `force` makes this
    // idempotent (no-op when the manifest is already gone).
    rmSync(manifestPath, { force: true });
  },
};
