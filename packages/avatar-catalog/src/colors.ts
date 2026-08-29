import type { ColorDefinition } from "./types.js";

/**
 * The avatar colour palette, in the order the picker offers it.
 *
 * Its own module because the palette is the one part of the catalog that
 * boot-path code needs: a sidebar pin resolves a stored colour id on first
 * render, and the accent CSS variable falls back to the first entry before
 * the daemon's own catalog arrives. Importing the shapes to reach six hex
 * values would put ~47 kB of SVG path data on that path.
 */
export const AVATAR_COLORS: ColorDefinition[] = [
  { id: "green", hex: "#4C9B50" },
  { id: "orange", hex: "#E9642F" },
  { id: "pink", hex: "#DB4B77" },
  { id: "purple", hex: "#A665C9" },
  { id: "teal", hex: "#0E9B8B" },
  { id: "yellow", hex: "#E9C91A" },
];
