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

/**
 * Whether the viewer is showing a surface that overlays the chat: a document,
 * a detail panel, channel setup. Everything that is neither the chat itself
 * nor an app.
 */
export function isOverlayView(mainView: MainView): boolean {
  return mainView !== "chat" && !isAppMainView(mainView);
}
