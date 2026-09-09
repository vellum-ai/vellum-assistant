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
 * This module is the single writer of avatar state and the single place a
 * change is announced: every successful mutation leaves the `## Avatar` note
 * in IDENTITY.md and runs the client + platform fan-out
 * (`publishAvatarChanged`). Callers (HTTP/IPC routes) go through it rather
 * than touching artifacts or the manifest directly, and never publish on
 * their own. The read-time accent repair in `accent-backfill.ts` is the one
 * other manifest write, and announces nothing.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  AVATAR_TRAITS_FILENAME,
} from "@vellumai/avatar-manifest";

import { publishAvatarChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import { getAvatarDir, getAvatarImagePath } from "../util/platform.js";
import { automaticAccent } from "./accent-backfill.js";
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
import {
  describeAvatarState,
  NO_AVATAR_IDENTITY_NOTE,
  updateIdentityAvatarSection,
} from "./identity-avatar.js";
import {
  ASCII_FILENAME,
  type CharacterTraits,
  type TraitsSyncResult,
  writeTraitsAndRenderAvatar,
} from "./traits-png-sync.js";

const log = getLogger("avatar-store");

export interface AvatarChangeOptions {
  /** The client that made the change, so it can ignore its own sync echo. */
  originClientId?: string;
}

export interface ImageChangeOptions extends AvatarChangeOptions {
  /** What the image shows, when known (the prompt an AI image came from). */
  imageDescription?: string;
}

/** The side effects every persisted change owes. */
function announceChange(
  identityNote: string,
  options?: AvatarChangeOptions,
): void {
  updateIdentityAvatarSection(identityNote);
  publishAvatarChanged(options?.originClientId);
}

/**
 * Sets the avatar to a builder-rendered character: writes traits.json, renders
 * the PNG + ASCII (via {@link writeTraitsAndRenderAvatar}), then records a
 * `character` manifest derived from the freshly-rendered PNG.
 *
 * Returns the underlying {@link TraitsSyncResult} unchanged so the route layer
 * keeps its existing error semantics (`invalid_traits` / `native_unavailable` /
 * `render_error`). The manifest is written ONLY when the render succeeded — a
 * failed render leaves both artifacts and manifest untouched, and announces
 * nothing.
 */
export function setCharacter(
  traits: CharacterTraits,
  options?: AvatarChangeOptions,
): TraitsSyncResult {
  const result = writeTraitsAndRenderAvatar(traits);
  if (!result.ok) {
    return result;
  }

  const state: AvatarState = {
    kind: "character",
    traits,
    source: "builder",
    image: computeImageMeta(getAvatarImagePath()),
    accent: paletteAccent(traits.color),
  };
  writeManifest(state);
  announceChange(describeAvatarState(state), options);
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
  options?: ImageChangeOptions,
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

  const state: AvatarState = {
    kind: "image",
    traits: null,
    source,
    image: computeImageMeta(pngPath),
    accent,
  };
  writeManifest(state);

  log.info(
    { source, accent: accent?.hex ?? null },
    "Set avatar from image and removed character sidecars",
  );
  announceChange(
    describeAvatarState(state, options?.imageDescription),
    options,
  );
}

/**
 * Sets the accent over the current avatar: a `#rrggbb` the user chose, or
 * `null` to go back to the automatic one. Returns the state as written, or
 * null when there is no avatar to colour. Only the manifest changes; the
 * artifacts are untouched, and so is the IDENTITY.md note, since the avatar
 * itself did not change.
 */
export async function setAccent(
  hex: string | null,
  options?: AvatarChangeOptions,
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
  publishAvatarChanged(options?.originClientId);
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
export function clearAvatar(options?: AvatarChangeOptions): void {
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  rmSync(join(avatarDir, AVATAR_IMAGE_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_MANIFEST_FILENAME), { force: true });

  log.info("Cleared avatar — removed all artifacts");
  announceChange(NO_AVATAR_IDENTITY_NOTE, options);
}
