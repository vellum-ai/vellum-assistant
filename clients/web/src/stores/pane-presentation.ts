/**
 * How the workspace arranges its two panes.
 *
 * Three facts decide it: whether a secondary surface is open, where the user
 * asked for it, and whether there is room for that answer. Deriving keeps
 * them independent, so opening, closing and moving a surface each change one
 * fact rather than re-deciding the arrangement, and no combination of them
 * can produce a layout nothing renders.
 */

/**
 * Where the user asked for the secondary pane.
 *
 * A preference rather than a consequence: a viewport with no room for
 * `"side"` presents `"bottom"` without overwriting it, so widening the window
 * answers what was asked for rather than making the user ask again.
 */
export type PanePosition = "side" | "bottom" | "full";

/**
 * What the workspace shows.
 *
 * `"full"` and `"single"` are one picture and two states: a surface filling
 * the width, with a secondary collapsed behind it or with none at all. The
 * difference is what makes a collapsed pane one click from returning, and a
 * closed one gone.
 */
export type PanePresentation = "single" | "side" | "bottom" | "full";

export interface PanePresentationInput {
  /** Whether a secondary surface is open, visible or collapsed. */
  hasSecondary: boolean;
  position: PanePosition;
  /** Whether the viewport is too narrow to stand two panes side by side. */
  isNarrow: boolean;
}

export function panePresentation({
  hasSecondary,
  position,
  isNarrow,
}: PanePresentationInput): PanePresentation {
  if (!hasSecondary) {
    return "single";
  }
  if (position === "full") {
    return "full";
  }
  // The one place the viewport has a say, and it narrows the answer rather
  // than replacing it: `position` is untouched, so the same preference reads
  // as `"side"` again once there is room.
  if (isNarrow) {
    return "bottom";
  }
  return position;
}
