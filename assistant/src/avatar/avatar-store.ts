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
 * in IDENTITY.md, runs the client + platform fan-out
 * (`publishAvatarChanged`), and records an `avatar_changed` telemetry event
 * unless the avatar came out identical. Mutating routes (HTTP/IPC) go through
 * it rather than touching artifacts or the manifest directly. The
 * `notify_avatar_updated` route and the avatar watcher in
 * `daemon/config-watcher.ts` republish out-of-band writes and record nothing.
 * Three other writers touch the manifest and announce and record nothing: the
 * read-time accent repair in `accent-backfill.ts`, the read routes' self-heal
 * persist in `runtime/routes/avatar-routes.ts`, and the
 * `094-seed-avatar-manifest` workspace migration.
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
import { recordTelemetryEvent } from "../telemetry/telemetry-events-outbox.js";
import { getLogger } from "../util/logger.js";
import { getAvatarDir, getAvatarImagePath } from "../util/platform.js";
import { automaticAccent } from "./accent-backfill.js";
import {
  deriveAccentHexFromImage,
  derivedAccent,
  paletteAccent,
} from "./avatar-accent.js";
import {
  type AvatarChangeAction,
  avatarChangedFields,
  IMAGE_ACTIONS,
  type ImageSource,
  isSameAvatar,
} from "./avatar-changed-telemetry.js";
import {
  type AvatarState,
  computeImageMeta,
  NONE_AVATAR_STATE,
  readAvatarState,
  writeManifest,
} from "./avatar-manifest.js";
import { readContainedAvatarRaster } from "./ensure-raster.js";
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
  /**
   * The caller's OS as reported by the client-metadata header, already
   * sanitized; carried on the telemetry event.
   */
  clientOs?: string;
}

export interface ImageChangeOptions extends AvatarChangeOptions {
  /** What the image shows, when known (the prompt an AI image came from). */
  imageDescription?: string;
}

interface AvatarTransition {
  action: AvatarChangeAction;
  previous: AvatarState;
  next: AvatarState;
  /** Set by the image write: the PNG bytes differ from the previous image's. */
  imageBytesChanged?: boolean;
}

/**
 * The side effects every persisted change owes. An identical re-set notifies
 * and is not counted. Telemetry is best effort: the avatar is
 * already written and announced, so a failed record is logged, not thrown.
 */
function announceChange(
  transition: AvatarTransition,
  identityNote: string | null,
  options?: AvatarChangeOptions,
): void {
  if (identityNote !== null) {
    updateIdentityAvatarSection(identityNote);
  }
  publishAvatarChanged(options?.originClientId);
  const { action, previous, next, imageBytesChanged } = transition;
  if (isSameAvatar(previous, next, imageBytesChanged)) {
    return;
  }
  try {
    recordTelemetryEvent(
      "avatar_changed",
      avatarChangedFields(action, previous, next, options?.clientOs),
    );
  } catch (err) {
    log.warn({ err, action }, "Failed to record the avatar_changed event");
  }
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
  const previous = readAvatarState();
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
  announceChange(
    { action: "set_character", previous, next: state },
    describeAvatarState(state),
    options,
  );
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
  source: ImageSource,
  options?: ImageChangeOptions,
): Promise<void> {
  const accent = derivedAccent(await deriveAccentHexFromImage(pngBuffer));
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  const pngPath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  const previous = readAvatarState();
  // Capped at the upload's own size: a larger file cannot be identical, and
  // the serving cap must not turn a big re-upload into a counted change.
  const previousBytes =
    previous.kind === "image"
      ? readContainedAvatarRaster(pngPath, pngBuffer.length)
      : null;
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
    {
      action: IMAGE_ACTIONS[source],
      previous,
      next: state,
      imageBytesChanged: !previousBytes?.equals(pngBuffer),
    },
    describeAvatarState(state, options?.imageDescription),
    options,
  );
}

/**
 * Sets the accent over the current avatar: a `#rrggbb` the user chose, or
 * `null` to go back to the automatic one. Returns the state as written, or
 * null when there is no avatar to colour. Only the manifest changes; the
 * artifacts are untouched, and so is the IDENTITY.md note, since the avatar
 * itself did not change. An accent that did not change is not counted.
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
  announceChange(
    { action: "set_accent", previous: state, next },
    null,
    options,
  );
  return next;
}

/**
 * Clears the avatar entirely: removes the PNG, character sidecars, and the
 * manifest itself. Idempotent: safe to call when nothing exists. Returns the
 * state it cleared, so a caller can tell whether an avatar was there.
 *
 * "No avatar" is represented by the ABSENCE of a manifest, not a persisted
 * `kind:"none"`. Deleting avatar.json (rather than writing `none`) keeps an
 * emptied workspace manifest-less, so a later legacy sidecar write is still
 * picked up by the read-time self-heal instead of being shadowed by a stale
 * `none` manifest.
 */
export function clearAvatar(options?: AvatarChangeOptions): AvatarState {
  const avatarDir = getAvatarDir();
  mkdirSync(avatarDir, { recursive: true });

  const previous = readAvatarState();
  rmSync(join(avatarDir, AVATAR_IMAGE_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_TRAITS_FILENAME), { force: true });
  rmSync(join(avatarDir, ASCII_FILENAME), { force: true });
  rmSync(join(avatarDir, AVATAR_MANIFEST_FILENAME), { force: true });

  log.info("Cleared avatar — removed all artifacts");
  announceChange(
    { action: "clear", previous, next: NONE_AVATAR_STATE },
    NO_AVATAR_IDENTITY_NOTE,
    options,
  );
  return previous;
}
