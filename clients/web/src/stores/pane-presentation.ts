/**
 * How the workspace arranges its two panes.
 *
 * The workspace shows a primary surface and, when one is open, a secondary
 * beside it. Which of those you actually see is a question about three
 * things, and only three: whether a secondary is open at all, where the user
 * has asked for it, and whether there is room for that answer.
 *
 * Deriving it is the point. The same arrangement is stored today across
 * `mainView` (`"app"` / `"app-editing"`) and `isAppMinimized`, so every path
 * that opens, closes or moves a surface has to re-decide the whole layout,
 * and a path that decides only part of it leaves a combination nothing
 * renders. A derived answer cannot be forgotten by a caller, because no
 * caller sets it.
 *
 * Nothing reads this yet. It exists so the readers of those fields can move
 * across one at a time against a fixed reference, with
 * `pane-presentation.test.ts` holding it to what the stored fields produce
 * today for every combination they can reach.
 */

/**
 * Where the user has asked for the secondary pane. A preference, not a
 * consequence: a viewport too narrow for `"side"` presents `"bottom"` without
 * overwriting the answer, so widening the window restores what was asked for.
 */
export type PanePosition = "side" | "bottom" | "full";

/**
 * What the workspace actually shows.
 *
 * `"full"` is distinct from `"single"`: the secondary is still open and one
 * click away, it is simply collapsed. `"single"` is no secondary at all.
 */
export type PanePresentation = "single" | "side" | "bottom" | "full";

export interface PanePresentationInput {
  /** Whether a secondary surface is open, whatever is currently visible. */
  hasSecondary: boolean;
  /** Where the user asked for it. */
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
  // The only place the viewport overrides the preference, and it narrows the
  // answer rather than replacing it: the stored position is left alone, so a
  // wider window presents `"side"` again without the user asking twice.
  if (isNarrow) {
    return "bottom";
  }
  return position;
}
