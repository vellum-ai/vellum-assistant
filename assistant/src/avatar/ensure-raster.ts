import { readFileSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getAvatarImagePath } from "../util/platform.js";
import {
  type AvatarState,
  deriveStateFromLegacyFiles,
  readManifest,
} from "./avatar-manifest.js";
import { writeTraitsAndRenderAvatar } from "./traits-png-sync.js";

const log = getLogger("ensure-raster");

/** Manifest first, legacy sidecars as fallback. Never persists. */
function readAvatarState(): AvatarState {
  return readManifest() ?? deriveStateFromLegacyFiles();
}

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
 * Returns the PNG raster for the current avatar, or null when there is none.
 *
 * Side-effect-free when the PNG already exists. A character whose PNG is
 * missing is re-rendered from its persisted traits (best-effort; null when
 * the native rasterizer is unavailable or the render fails). An image-kind
 * avatar with a missing PNG cannot be recovered and yields null.
 *
 * Callers that already hold the avatar state can pass it to skip the re-read.
 */
export async function ensureAvatarRaster(
  state: AvatarState = readAvatarState(),
): Promise<Buffer | null> {
  if (state.kind === "none") {
    return null;
  }

  const avatarPath = getAvatarImagePath();
  const existing = readPng(avatarPath);
  if (existing || state.kind !== "character" || !state.traits) {
    return existing;
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

  return readPng(avatarPath);
}
