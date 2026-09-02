import { join } from "node:path";

/** Path segments of the avatar directory below the workspace directory. */
const AVATAR_DIR_SEGMENTS: readonly string[] = ["data", "avatar"];

/** Avatar state manifest. */
export const AVATAR_MANIFEST_FILENAME = "avatar.json";

/** Legacy sidecar holding the persisted character traits. */
export const AVATAR_TRAITS_FILENAME = "character-traits.json";

/** The avatar PNG (uploaded, or rendered from the character traits). */
export const AVATAR_IMAGE_FILENAME = "avatar-image.png";

/** The avatar directory for a workspace (`<workspace>/data/avatar`). */
export function resolveAvatarDir(workspaceDir: string): string {
  return join(workspaceDir, ...AVATAR_DIR_SEGMENTS);
}
