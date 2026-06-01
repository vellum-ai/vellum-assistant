/**
 * Avatar store — atomic, transition-aware avatar mutations.
 *
 * Each operation updates the on-disk artifacts (PNG / traits / ASCII) AND the
 * canonical manifest (`avatar.json`) together, removing artifacts that no
 * longer belong to the new state. Artifacts are written FIRST and the manifest
 * LAST, so an interrupted call never leaves the manifest pointing at a state
 * the artifacts don't back. This mirrors the "traits before PNG" ordering in
 * traits-png-sync.ts.
 *
 * This module is the single writer of avatar state. Callers (HTTP/IPC routes)
 * should go through it rather than touching artifacts or the manifest directly.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  getAvatarDir,
  getAvatarImagePath,
} from "../util/platform.js";
import {
  type AvatarSource,
  computeImageMeta,
  writeManifest,
} from "./avatar-manifest.js";
import {
  ASCII_FILENAME,
  type CharacterTraits,
  TRAITS_FILENAME,
  type TraitsSyncResult,
  writeTraitsAndRenderAvatar,
} from "./traits-png-sync.js";

const log = getLogger("avatar-store");

/**
 * Sets the avatar to a builder-rendered character: writes traits.json, renders
 * the PNG + ASCII (via {@link writeTraitsAndRenderAvatar}), then records a
 * `character` manifest derived from the freshly-rendered PNG.
 *
 * Returns the underlying {@link TraitsSyncResult} unchanged so the route layer
 * keeps its existing error semantics (`invalid_traits` / `native_unavailable` /
 * `render_error`). The manifest is written ONLY when the render succeeded — a
 * failed render leaves both artifacts and manifest untouched.
 */
export function setCharacter(traits: CharacterTraits): TraitsSyncResult {
  const result = writeTraitsAndRenderAvatar(traits);
  if (!result.ok) {
    return result;
  }

  writeManifest({
    kind: "character",
    traits,
    source: "builder",
    image: computeImageMeta(getAvatarImagePath()),
  });
  return result;
}

/**
 * Sets the avatar to an uploaded/AI image: atomically writes the PNG, removes
 * the now-stale character sidecars (traits + ASCII), then records an `image`
 * manifest. The PNG is written before the manifest so an interrupted call never
 * leaves the manifest ahead of the artifact.
 */
export function setImage(pngBuffer: Buffer, source: AvatarSource): void {
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  const pngPath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  const pngTmp = `${pngPath}.${randomUUID()}.tmp`;
  writeFileSync(pngTmp, pngBuffer);
  renameSync(pngTmp, pngPath);

  rmSync(join(avatarDir, TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });

  writeManifest({
    kind: "image",
    traits: null,
    source,
    image: computeImageMeta(pngPath),
  });

  log.info({ source }, "Set avatar from image and removed character sidecars");
}

/**
 * Clears the avatar entirely: removes the PNG, character sidecars, and the
 * manifest itself. Idempotent — safe to call when nothing exists.
 *
 * "No avatar" is represented by the ABSENCE of a manifest, not a persisted
 * `kind:"none"`. Deleting avatar.json (rather than writing `none`) keeps an
 * emptied workspace manifest-less, so a later legacy sidecar write is still
 * picked up by the read-time self-heal instead of being shadowed by a stale
 * `none` manifest.
 */
export function clearAvatar(): void {
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  rmSync(join(avatarDir, AVATAR_IMAGE_FILENAME), { force: true });
  rmSync(join(avatarDir, TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_MANIFEST_FILENAME), { force: true });

  log.info("Cleared avatar — removed all artifacts");
}
