import { createLucideIcon } from "lucide-react";

/**
 * Lucide's plus with its two strokes merged into one path.
 *
 * Drawn as lucide draws it, with a `<path>` per stroke, the glyph can break
 * where the two cross: one stroke's rasterization lands over the other rather
 * than blending with it, and the pixels underneath are lost. Merged into
 * subpaths of a single `<path>` they are one shape, with no boundary between
 * them for that to happen along.
 *
 * Built through `createLucideIcon` so this stays a lucide icon: the wrapper,
 * its defaults, sizing, `className` handling and `strokeWidth` plumbing all
 * come from lucide, and only the path data differs.
 */
export const PlusIcon = createLucideIcon("plus", [
  ["path", { d: "M5 12h14M12 5v14", key: "plus-merged" }],
]);
