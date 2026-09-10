/**
 * The accent an avatar earns on its own, and the read-time repair that fills
 * it into a manifest written before accents were persisted.
 *
 * Separate from the avatar store so a reader that must announce nothing (the
 * state route, the platform sync) can repair the accent without reaching the
 * store's client and platform fan-out.
 */
import type { AvatarAccent } from "@vellumai/avatar-manifest";

import { getLogger } from "../util/logger.js";
import { getAvatarImagePath } from "../util/platform.js";
import {
  deriveAccentHexFromImage,
  derivedAccent,
  paletteAccent,
} from "./avatar-accent.js";
import { type AvatarState, writeManifest } from "./avatar-manifest.js";
import { readContainedAvatarRaster } from "./ensure-raster.js";

const log = getLogger("accent-backfill");

/**
 * The accent the current avatar earns on its own: a character's palette
 * colour, or the colour read out of the image on disk. Null for `none`, and
 * for an image that cannot be read.
 */
export async function automaticAccent(
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
 * being written only by the avatar store's mutations, for the same reason the
 * read handlers self-heal a missing manifest: the accent is derivable from
 * what is on disk, and deriving it once beats every client deriving it on
 * every read. The persist is best-effort; a read-only workspace still gets
 * the accent.
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
