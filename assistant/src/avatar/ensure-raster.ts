import { existsSync, readFileSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getAvatarImagePath } from "../util/platform.js";
import { type AvatarState, readAvatarState } from "./avatar-manifest.js";
import { writeTraitsAndRenderAvatar } from "./traits-png-sync.js";

const log = getLogger("ensure-raster");

function readPng(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Returns the on-disk path of the current avatar PNG, or null when there is
 * none. Never reads the raster bytes.
 *
 * Side-effect-free when the PNG already exists. A character whose PNG is
 * missing is re-rendered from its persisted traits (best-effort; null when
 * the native rasterizer is unavailable or the render fails). An image-kind
 * avatar with a missing PNG cannot be recovered and yields null.
 *
 * Callers that already hold the avatar state can pass it to skip the re-read.
 */
export async function ensureAvatarRasterPath(
  state: AvatarState = readAvatarState(),
): Promise<string | null> {
  if (state.kind === "none") {
    return null;
  }

  const avatarPath = getAvatarImagePath();
  if (existsSync(avatarPath)) {
    return avatarPath;
  }
  if (state.kind !== "character" || !state.traits) {
    return null;
  }

  try {
    const result = writeTraitsAndRenderAvatar(state.traits);
    if (!result.ok) {
      log.warn({ reason: result.reason }, "Avatar raster re-render failed");
      return null;
    }
  } catch (err) {
    log.warn({ err }, "Avatar raster re-render threw");
    return null;
  }

  return existsSync(avatarPath) ? avatarPath : null;
}

/**
 * Returns the PNG raster for the current avatar, or null when there is none.
 * Same existence and regeneration semantics as `ensureAvatarRasterPath`.
 */
export async function ensureAvatarRaster(
  state: AvatarState = readAvatarState(),
): Promise<Buffer | null> {
  const avatarPath = await ensureAvatarRasterPath(state);
  return avatarPath ? readPng(avatarPath) : null;
}
