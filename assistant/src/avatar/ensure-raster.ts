import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { getLogger } from "../util/logger.js";
import { getAvatarImagePath, getWorkspaceDir } from "../util/platform.js";
import { type AvatarState, readAvatarState } from "./avatar-manifest.js";
import { writeTraitsAndRenderAvatar } from "./traits-png-sync.js";

const log = getLogger("ensure-raster");

/** Largest raster any reader serves; a bigger file is treated as unreadable. */
export const AVATAR_RASTER_MAX_BYTES = 5 * 1024 * 1024;

function isWithin(dir: string, filePath: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Reads the raster only when it is a regular file that truly lives under the
 * avatar dir: a symlinked PNG (or a symlinked ancestor) would let the
 * workspace hand a reader an arbitrary host file. Validation and the read
 * share one descriptor so a concurrent swap of the path cannot slip a
 * different file past the checks, and the descriptor's location is
 * revalidated after the open. Returns null when the file is missing,
 * symlinked, outside the avatar dir, not a regular file, or over the cap.
 */
export function readContainedAvatarRaster(rasterPath: string): Buffer | null {
  let fd: number | undefined;
  try {
    // Anchored on the real workspace root: a data/avatar symlink pointing at
    // another workspace resolves outside it and is rejected.
    // The root is resolved once and reused after the open so a workspace
    // pathname swapped for a symlink mid-read cannot re-anchor the check.
    const realRoot = realpathSync(getWorkspaceDir());
    const realDir = realpathSync(dirname(rasterPath));
    if (!isWithin(realRoot, realDir)) {
      return null;
    }
    const realPath = join(realDir, basename(rasterPath));
    const linkStats = lstatSync(realPath);
    if (!linkStats.isFile()) {
      return null;
    }
    fd = openSync(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.dev !== linkStats.dev ||
      stats.ino !== linkStats.ino ||
      stats.size > AVATAR_RASTER_MAX_BYTES
    ) {
      return null;
    }
    // O_NOFOLLOW guards only the last component; an ancestor swapped for an
    // outside symlink between the check and the open either stays swapped
    // (fresh realpath resolves outside) or is swapped back (the inside file
    // is a different inode than the opened fd). Node has no openat.
    const reopenedPath = realpathSync(rasterPath);
    if (!isWithin(realRoot, reopenedPath)) {
      return null;
    }
    const reopenedStats = lstatSync(reopenedPath);
    if (
      !reopenedStats.isFile() ||
      reopenedStats.dev !== stats.dev ||
      reopenedStats.ino !== stats.ino
    ) {
      return null;
    }
    const bytes = readFileSync(fd);
    return bytes.length > AVATAR_RASTER_MAX_BYTES ? null : bytes;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
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
    if (result.ok) {
      return avatarPath;
    }
    log.warn({ reason: result.reason }, "Avatar raster re-render failed");
  } catch (err) {
    log.warn({ err }, "Avatar raster re-render threw");
  }
  return null;
}

/**
 * Returns the PNG raster for the current avatar, or null when there is none
 * or it cannot be read (see `readContainedAvatarRaster`). Same regeneration
 * semantics as `ensureAvatarRasterPath`.
 */
export async function ensureAvatarRaster(
  state: AvatarState = readAvatarState(),
): Promise<Buffer | null> {
  const avatarPath = await ensureAvatarRasterPath(state);
  if (!avatarPath) {
    return null;
  }
  const bytes = readContainedAvatarRaster(avatarPath);
  if (!bytes) {
    log.warn({ path: avatarPath }, "Avatar raster unreadable or not contained");
  }
  return bytes;
}
