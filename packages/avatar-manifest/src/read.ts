import { existsSync, readFileSync } from "node:fs";
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

function readJsonFile(filePath: string): unknown {
  try {
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
