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

/**
 * The fields the viewer stores about an app and the conversation beside it.
 */
export interface ViewerPaneFields {
  /** The viewer's main view. */
  mainView: string;
  /** Whether an app is loaded into the viewer. */
  hasApp: boolean;
  /** Whether a conversation is bound to the pane beside the app. */
  hasBoundConversation: boolean;
  /** Whether the app is parked to its strip. */
  isAppMinimized: boolean;
}

/**
 * Read the stored fields as the arrangement they describe.
 *
 * The viewport is not consulted. The stored arrangement already reflects the
 * room available when it was chosen, since every path into the side-by-side
 * layout refuses a viewport with no space for two columns, so narrowing it
 * again here would answer a question nobody asked. A position the user sets
 * directly is a different matter, and {@link panePresentation} takes the
 * viewport for that reason.
 */
export function viewerPanePresentation({
  mainView,
  hasApp,
  hasBoundConversation,
  isAppMinimized,
}: ViewerPaneFields): PanePresentation {
  if (!hasApp || (mainView !== "app" && mainView !== "app-editing")) {
    return "single";
  }
  // Which surface is the secondary depends on the arrangement. Beside the
  // app and behind it, the secondary is the conversation, so an unbound one
  // means there is no second surface at all. Parked to the strip, the app is
  // itself the secondary and the conversation has the surface.
  if (mainView === "app-editing") {
    return panePresentation({
      hasSecondary: hasBoundConversation,
      position: "side",
      isNarrow: false,
    });
  }
  if (isAppMinimized) {
    return panePresentation({
      hasSecondary: true,
      position: "bottom",
      isNarrow: false,
    });
  }
  return panePresentation({
    hasSecondary: hasBoundConversation,
    position: "full",
    isNarrow: false,
  });
}
