/**
 * The character catalog as a module-scope value, so the app can compose an
 * avatar before the daemon answers `/avatar/character-components` (the
 * hatching screen, the assistant chooser, a transcript's subagent chips).
 *
 * A value rather than a call at each site: consumers pass this straight into
 * React components and effect dependencies, and `getCharacterComponents()`
 * builds a fresh object every call, so calling per site would hand them a new
 * identity on every render.
 *
 * This module carries the ~47 kB of SVG path data. Boot-path code that needs
 * only the palette imports `@/utils/avatar-bundled-colors` instead.
 */

import { getCharacterComponents } from "@vellumai/avatar-catalog";

import type { CharacterComponents } from "@/types/avatar";

export const BUNDLED_COMPONENTS: CharacterComponents = getCharacterComponents();
