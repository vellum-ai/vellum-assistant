import { createLucideIcon } from "lucide-react";

/**
 * Lucide's plus with its two strokes merged into one path.
 *
 * On device the composer's plus shows a break where the horizontal bar meets
 * the vertical stroke. Measured off a screenshot at native scale, the vertical
 * stroke's whole footprint is painted identically whether or not the bar runs
 * underneath it, its transparent margin included: the stroke's rasterization
 * is copied over the bar rather than blended with it, so the bar's own pixels
 * are lost across those columns.
 *
 * Lucide draws the plus as two separate `<path>` elements, which is what gives
 * that copy a second shape to happen between. The same strokes as subpaths of
 * one `<path>` are a single shape to the rasterizer.
 *
 * Built through `createLucideIcon` so this stays a lucide icon rather than a
 * hand-drawn one: the wrapper, its defaults, sizing, `className` handling and
 * `strokeWidth` plumbing all come from lucide, and only the path data differs.
 *
 * What triggers the copy is not established. Neither Chromium nor desktop
 * WebKit reproduces it across scales, sub-pixel offsets, the button's own
 * chrome, or ten compositing contexts, and both path forms render identically
 * in every one. So this is the remedy the measurement points at rather than a
 * confirmed fix, and only a device can tell whether it lands.
 */
export const PlusIcon = createLucideIcon("plus", [
  ["path", { d: "M5 12h14M12 5v14", key: "plus-merged" }],
]);
