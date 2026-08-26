import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Symlinked sidecars are treated as absent so a workspace cannot point them
 * at host files; oversized ones are absent so a host never parses an
 * unbounded file just to render a row.
 */
function readJsonFile(filePath: string): unknown {
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.size > AVATAR_SIDECAR_MAX_BYTES) {
      return undefined;
    }
    return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return undefined;
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
    manifestJson: readJsonFile(join(avatarDir, AVATAR_MANIFEST_FILENAME)),
    traitsJson: readJsonFile(join(avatarDir, AVATAR_TRAITS_FILENAME)),
    hasImage: existsSync(imagePath),
  });
  return resolved.kind === "image" ? { kind: "image", imagePath } : resolved;
}
