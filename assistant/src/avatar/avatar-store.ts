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

import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  AVATAR_TRAITS_FILENAME,
  type AvatarAccent,
} from "@vellumai/avatar-manifest";

import { getLogger } from "../util/logger.js";
import { getAvatarDir, getAvatarImagePath } from "../util/platform.js";
import {
  deriveAccentHexFromImage,
  derivedAccent,
  paletteAccent,
} from "./avatar-accent.js";
import {
  type AvatarSource,
  type AvatarState,
  computeImageMeta,
  readAvatarState,
  writeManifest,
} from "./avatar-manifest.js";
import { readContainedAvatarRaster } from "./ensure-raster.js";
import {
  ASCII_FILENAME,
  type CharacterTraits,
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
    accent: paletteAccent(traits.color),
  });
  return result;
}

/**
 * Sets the avatar to an uploaded/AI image: atomically writes the PNG, removes
 * the now-stale character sidecars (traits + ASCII), then records an `image`
 * manifest carrying the accent read out of the image. The accent is derived
 * before anything is written and the PNG is written before the manifest, so an
 * interrupted call never leaves the manifest ahead of the artifact.
 */
export async function setImage(
  pngBuffer: Buffer,
  source: AvatarSource,
): Promise<void> {
  const accent = derivedAccent(await deriveAccentHexFromImage(pngBuffer));
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  const pngPath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  const pngTmp = `${pngPath}.${randomUUID()}.tmp`;
  writeFileSync(pngTmp, pngBuffer);
  renameSync(pngTmp, pngPath);

  rmSync(join(avatarDir, AVATAR_TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });

  writeManifest({
    kind: "image",
    traits: null,
    source,
    image: computeImageMeta(pngPath),
    accent,
  });

  log.info(
    { source, accent: accent?.hex ?? null },
    "Set avatar from image and removed character sidecars",
  );
}

/**
 * The accent the current avatar earns on its own: a character's palette
 * colour, or the colour read out of the image on disk. Null for `none`, and
 * for an image that cannot be read.
 */
async function automaticAccent(
  state: AvatarState,
): Promise<AvatarAccent | null> {
  if (state.kind === "character" && state.traits) {
    return paletteAccent(state.traits.color);
  }
  if (state.kind === "image") {
    const bytes = readContainedAvatarRaster(getAvatarImagePath());
    return bytes ? derivedAccent(await deriveAccentHexFromImage(bytes)) : null;
  }
  return null;
}

/**
 * Sets the accent over the current avatar: a `#rrggbb` the user chose, or
 * `null` to go back to the automatic one. Returns the state as written, or
 * null when there is no avatar to colour. Only the manifest changes; the
 * artifacts are untouched.
 */
export async function setAccent(
  hex: string | null,
): Promise<AvatarState | null> {
  const state = readAvatarState();
  if (state.kind === "none") {
    return null;
  }
  const next: AvatarState = {
    ...state,
    accent: hex ? { hex, source: "custom" } : await automaticAccent(state),
  };
  writeManifest(next);
  return next;
}

/**
 * Image etags whose accent derivation came back empty. Remembered so a read
 * of an unreadable image does not decode it again on every request; a new
 * upload carries a new etag and is tried afresh.
 */
const accentlessImageEtags = new Set<string>();
/** The one derivation in flight per etag, so concurrent reads share it. */
const pendingAccents = new Map<string, Promise<AvatarAccent | null>>();

/**
 * Fills in the accent of a state written before accents existed, persisting
 * it so later reads are manifest-only. The one exception to the manifest
 * being written only by the mutations above, for the same reason the read
 * handlers self-heal a missing manifest: the accent is derivable from what is
 * on disk, and deriving it once beats every client deriving it on every read.
 * The persist is best-effort; a read-only workspace still gets the accent.
 */
export async function backfillAccent(state: AvatarState): Promise<AvatarState> {
  if (state.kind === "none" || state.accent !== null) {
    return state;
  }
  const etag = state.image?.etag ?? null;
  if (etag && accentlessImageEtags.has(etag)) {
    return state;
  }
  const key = etag ?? state.kind;
  let pending = pendingAccents.get(key);
  if (!pending) {
    pending = automaticAccent(state).finally(() => {
      pendingAccents.delete(key);
    });
    pendingAccents.set(key, pending);
  }
  const accent = await pending;
  if (!accent) {
    if (etag) {
      accentlessImageEtags.add(etag);
    }
    return state;
  }
  const next: AvatarState = { ...state, accent };
  try {
    writeManifest(next);
  } catch (err) {
    log.warn({ err }, "Failed to persist the backfilled avatar accent");
  }
  return next;
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
  rmSync(join(avatarDir, AVATAR_TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_MANIFEST_FILENAME), { force: true });

  log.info("Cleared avatar — removed all artifacts");
}
