/**
 * @vellumai/avatar-catalog: the single definition of the components an
 * assistant's character avatar is composed from.
 *
 * The daemon serves this catalog over `/avatar/character-components` and
 * renders PNGs from it; clients bundle it because an avatar has to compose
 * before the daemon can answer (the hatching screen, the assistant chooser,
 * a transcript's subagent chips). Bundling is why this is a package rather
 * than a daemon module every client copies.
 *
 * Import `@vellumai/avatar-catalog/colors` on a path that needs only the
 * palette: the shapes are ~47 kB of SVG, and boot-path code that resolves a
 * stored colour id must not carry them.
 *
 * Leaf package: no dependencies, no runtime imports.
 */
export { getCharacterComponents } from "./catalog.js";
export { AVATAR_COLORS } from "./colors.js";
export type {
  BodyShapeDefinition,
  CharacterComponents,
  ColorDefinition,
  EyePathDefinition,
  EyeStyleDefinition,
  FaceCenterOverride,
} from "./types.js";
