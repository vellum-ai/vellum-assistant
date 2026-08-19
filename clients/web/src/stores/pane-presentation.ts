/**
 * How the workspace arranges its two panes: whether a secondary surface is
 * open, where the user asked for it, and whether there is room for that.
 */

import type { MainView } from "@/stores/viewer-store";

/**
 * Where the user asked for the secondary pane. A viewport with no room for
 * `"side"` presents `"bottom"` without overwriting it.
 */
export type PanePosition = "side" | "bottom" | "full";

/**
 * What the workspace shows. `"full"` and `"single"` are one picture and two
 * states: a surface filling the width, with a secondary collapsed behind it
 * or with none at all.
 */
export type PanePresentation = "single" | "side" | "bottom" | "full";

export interface PanePresentationInput {
  /** Open, whether visible or collapsed. */
  hasSecondary: boolean;
  position: PanePosition;
  /** Too narrow to stand two panes side by side. */
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
  // `position` is untouched, so the same preference reads as `"side"` again
  // once there is room.
  if (isNarrow) {
    return "bottom";
  }
  return position;
}

/** Whether the viewer is showing an app, in any arrangement. */
export function isAppMainView(mainView: MainView): boolean {
  return mainView === "app" || mainView === "app-editing";
}

/** The fields the viewer stores about an app and the conversation beside it. */
export interface ViewerPaneFields {
  mainView: MainView;
  hasApp: boolean;
  hasBoundConversation: boolean;
  isAppMinimized: boolean;
}

/**
 * Read the stored fields as the arrangement they describe.
 *
 * The viewport is not consulted: a stored arrangement already reflects the
 * room available when it was chosen, since every path into the side-by-side
 * layout refuses a viewport with no space for two columns.
 */
export function viewerPanePresentation({
  mainView,
  hasApp,
  hasBoundConversation,
  isAppMinimized,
}: ViewerPaneFields): PanePresentation {
  if (!hasApp || !isAppMainView(mainView)) {
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
