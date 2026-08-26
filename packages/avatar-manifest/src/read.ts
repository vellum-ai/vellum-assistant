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
import { basename, dirname, join, sep } from "node:path";

import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  AVATAR_TRAITS_FILENAME,
  resolveAvatarDir,
} from "./layout.js";
import { type CharacterTraits, resolveAvatarFromFiles } from "./manifest.js";

export type WorkspaceAvatar =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image"; imagePath: string }
  | { kind: "none" };

/** Largest sidecar a host parses; a bigger one counts as absent. */
export const AVATAR_SIDECAR_MAX_BYTES = 64 * 1024;

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Sidecars are read through one validated descriptor: the parent must
 * resolve beneath the real workspace (a symlinked avatar dir is rejected),
 * the file must be a regular file at or under the cap, and the open uses
 * O_NOFOLLOW with a post-open recheck so a swap between check and read
 * cannot substitute another file. Anything else counts as absent.
 */
function readJsonFile(workspaceDir: string, filePath: string): unknown {
  let fd: number | undefined;
  try {
    const realRoot = realpathSync(workspaceDir);
    const realDir = realpathSync(dirname(filePath));
    if (!isWithin(realRoot, realDir)) {
      return undefined;
    }
    const realPath = join(realDir, basename(filePath));
    const linkStats = lstatSync(realPath);
    if (!linkStats.isFile() || linkStats.size > AVATAR_SIDECAR_MAX_BYTES) {
      return undefined;
    }
    fd = openSync(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.dev !== linkStats.dev ||
      stats.ino !== linkStats.ino ||
      stats.size > AVATAR_SIDECAR_MAX_BYTES
    ) {
      return undefined;
    }
    const reopened = realpathSync(filePath);
    if (!isWithin(realRoot, reopened)) {
      return undefined;
    }
    const reopenedStats = lstatSync(reopened);
    if (
      !reopenedStats.isFile() ||
      reopenedStats.dev !== stats.dev ||
      reopenedStats.ino !== stats.ino
    ) {
      return undefined;
    }
    const text = readFileSync(fd, "utf-8");
    if (Buffer.byteLength(text) > AVATAR_SIDECAR_MAX_BYTES) {
      return undefined;
    }
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Reads the avatar of a workspace directly off disk. Unreadable or corrupt
 * files count as absent. For an image avatar the caller reads the PNG at
 * `imagePath` itself, applying its own size policy; the file may be missing.
 */
export function readWorkspaceAvatar(workspaceDir: string): WorkspaceAvatar {
  const avatarDir = resolveAvatarDir(workspaceDir);
  const imagePath = join(avatarDir, AVATAR_IMAGE_FILENAME);
  const resolved = resolveAvatarFromFiles({
    manifestJson: readJsonFile(
      workspaceDir,
      join(avatarDir, AVATAR_MANIFEST_FILENAME),
    ),
    traitsJson: readJsonFile(
      workspaceDir,
      join(avatarDir, AVATAR_TRAITS_FILENAME),
    ),
    hasImage: existsSync(imagePath),
  });
  return resolved.kind === "image" ? { kind: "image", imagePath } : resolved;
}
