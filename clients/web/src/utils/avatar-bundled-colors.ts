/**
 * Static bundled copy of the avatar color palette, split from
 * `avatar-bundled-components` so palette-only consumers on the boot path
 * (pin colors, the accent-var fallback) don't pull the ~47 kB of SVG path
 * data into the boot graph. `avatar-bundled-components` re-exposes this
 * array as `BUNDLED_COMPONENTS.colors`, so there is exactly one bundled
 * definition of the palette.
 *
 * Canonical source: assistant/src/avatar/character-components.ts
 * Keep in sync when colors change.
 */

import type { ColorDefinition } from "@/types/avatar";

export const BUNDLED_COLORS: ColorDefinition[] = [
  { id: "green", hex: "#4C9B50" },
  { id: "orange", hex: "#E9642F" },
  { id: "pink", hex: "#DB4B77" },
  { id: "purple", hex: "#A665C9" },
  { id: "teal", hex: "#0E9B8B" },
  { id: "yellow", hex: "#E9C91A" },
];
