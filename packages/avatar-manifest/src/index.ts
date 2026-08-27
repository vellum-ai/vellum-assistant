/**
 * @vellumai/avatar-manifest: the single source of truth for the on-disk
 * avatar layout of an assistant workspace (`<workspace>/data/avatar`) and
 * how its files resolve to an avatar.
 *
 * The daemon owns the files (it writes the manifest and sidecars); hosts
 * such as the desktop app read them directly so a sleeping assistant still
 * has an avatar in the chooser. Both go through the parsing and legacy
 * derivation here so they cannot disagree. Leaf package: node builtins only.
 */
export {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  AVATAR_TRAITS_FILENAME,
  resolveAvatarDir,
} from "./layout.js";
export {
  deriveAvatarFromLegacyFiles,
  parseAvatarManifest,
} from "./manifest.js";
export type {
  AvatarImageMeta,
  AvatarKind,
  AvatarSource,
  AvatarState,
  CharacterTraits,
} from "./manifest.js";
export { readWorkspaceAvatar } from "./read.js";
export type { WorkspaceAvatar } from "./read.js";
