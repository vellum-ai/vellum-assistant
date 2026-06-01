/**
 * Avatar state manifest — schema + pure filesystem helpers.
 *
 * The manifest (`avatar.json`) is the canonical record of the user's avatar
 * configuration. This module is intentionally pure: it only reads/writes the
 * filesystem and derives state from legacy sidecar files. It must not import
 * route or handler code.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  getAvatarDir,
} from "../util/platform.js";
import { type CharacterTraits, TRAITS_FILENAME } from "./traits-png-sync.js";

const log = getLogger("avatar-manifest");

export type AvatarKind = "character" | "image" | "none";
export type AvatarSource = "builder" | "upload" | "ai";

export interface AvatarImageMeta {
  updatedAt: string;
  etag: string;
}

export interface AvatarState {
  kind: AvatarKind;
  traits: CharacterTraits | null;
  source: AvatarSource | null;
  image: AvatarImageMeta | null;
}

const AVATAR_KINDS: ReadonlySet<string> = new Set<AvatarKind>([
  "character",
  "image",
  "none",
]);

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

/** Narrows an unknown value to valid AvatarImageMeta (presence check only). */
function isValidImageMeta(value: unknown): value is AvatarImageMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.updatedAt === "string" &&
    !!m.updatedAt &&
    typeof m.etag === "string" &&
    !!m.etag
  );
}

/**
 * Reads and validates the avatar manifest. Returns `null` when the manifest is
 * missing, unreadable, unparseable, has an invalid `kind`, or carries a
 * partial/malformed per-kind payload so callers can fall back to legacy
 * derivation rather than surfacing an avatar with null traits/image.
 */
export function readManifest(
  avatarDir: string = getAvatarDir(),
): AvatarState | null {
  const manifestPath = join(avatarDir, AVATAR_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.kind !== "string" || !AVATAR_KINDS.has(obj.kind)) {
      return null;
    }
    const kind = obj.kind as AvatarKind;

    // Reject partial manifests: a valid `kind` with a missing/malformed payload
    // would otherwise short-circuit the legacy fallback and surface an avatar
    // with null traits/image.
    if (kind === "character" && !isValidTraits(obj.traits)) return null;
    if (kind === "image" && !isValidImageMeta(obj.image)) return null;

    return {
      kind,
      traits: (obj.traits as CharacterTraits | null) ?? null,
      source: (obj.source as AvatarSource | null) ?? null,
      image: (obj.image as AvatarImageMeta | null) ?? null,
    };
  } catch (err) {
    log.warn({ err }, "Failed to read avatar manifest — treating as absent");
    return null;
  }
}

/**
 * Writes the avatar manifest atomically (tmp-write + rename), mirroring the
 * write pattern in traits-png-sync.ts.
 */
export function writeManifest(
  state: AvatarState,
  avatarDir: string = getAvatarDir(),
): void {
  mkdirSync(avatarDir, { recursive: true });
  const manifestPath = join(avatarDir, AVATAR_MANIFEST_FILENAME);
  const tmp = `${manifestPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, manifestPath);
}

/** Computes a stable etag for the avatar image from its size and mtime. */
function computeImageEtag(sizeBytes: number, mtimeMs: number): string {
  return createHash("sha256")
    .update(`${sizeBytes}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Computes {@link AvatarImageMeta} for an avatar PNG already on disk. The etag
 * is derived from the file's size and mtime and `updatedAt` is the mtime in ISO
 * form, so both the legacy-derivation path and the store's write path agree on
 * the same meta shape for the same file. Caller must ensure the file exists.
 */
export function computeImageMeta(imagePath: string): AvatarImageMeta {
  const stats = statSync(imagePath);
  return {
    updatedAt: new Date(stats.mtimeMs).toISOString(),
    etag: computeImageEtag(stats.size, stats.mtimeMs),
  };
}

/**
 * Derives avatar state from the legacy sidecar files (traits JSON + PNG).
 * Used by the read handlers to self-heal once on a manifest-miss: the derived
 * state is persisted via `writeManifest` so subsequent reads are manifest-only.
 *
 * Inference is **traits-first**: whenever a valid `character-traits.json`
 * exists, the result is `character` regardless of whether a PNG is also
 * present. We deliberately do NOT compare mtimes to break the both-present
 * tie, because the builder writes the rendered PNG *after* the traits file
 * (see traits-png-sync.ts), so the PNG is always newer even when the
 * character is the source of truth. Comparing mtimes would misclassify a
 * builder-generated character as an uploaded image.
 */
export function deriveStateFromLegacyFiles(
  avatarDir: string = getAvatarDir(),
): AvatarState {
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
    return {
      kind: "image",
      traits: null,
      source: null,
      image: computeImageMeta(imagePath),
    };
  }

  return { kind: "none", traits: null, source: null, image: null };
}
