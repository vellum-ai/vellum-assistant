/**
 * What the workspace is showing: the arrangement, and the surface in each
 * pane.
 *
 * One reading of the viewer's fields answers both. They are two views of a
 * single fact, and deriving them separately lets them contradict each other,
 * reporting two panes while producing one surface.
 */

import type { MainView } from "@/stores/viewer-store";

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

/**
 * What the workspace shows. `"full"` and `"single"` are one picture and two
 * states: a surface filling the width, with a secondary collapsed behind it
 * or with none at all.
 */
export type PanePresentation = "single" | "side" | "bottom" | "full";

/** A thing a pane can show: a kind, and the id of what it shows. */
export type PaneSurface =
  | { kind: "conversation"; id: string }
  | { kind: "app"; id: string };

export interface PaneState {
  presentation: PanePresentation;
  /** The surface with the room. */
  primary: PaneSurface | null;
  /** The surface sharing it, or waiting collapsed beside it. */
  secondary: PaneSurface | null;
}

export interface PaneStateFields {
  mainView: MainView;
  /** The app the viewer holds, if any. */
  appId: string | null;
  /** The conversation the workspace is loaded on. */
  conversationId: string | null;
  /** The conversation bound to the pane beside the app. */
  boundConversationId: string | null;
  isAppMinimized: boolean;
}

function conversationSurface(id: string | null): PaneSurface | null {
  return id === null ? null : { kind: "conversation", id };
}

/**
 * Read the viewer's fields as a pair of panes and the arrangement holding
 * them.
 *
 * Which surface takes which pane is not fixed by kind. An app beside a
 * conversation has the room while the conversation shares it; an app parked
 * to its strip has given the room to the conversation and waits there itself.
 *
 * A pane cannot hold nothing while the arrangement claims two, so an
 * arrangement is only reported when both surfaces exist. Parked with no
 * conversation to stand in front is one surface, not a strip over an empty
 * pane.
 */
export function paneState({
  mainView,
  appId,
  conversationId,
  boundConversationId,
  isAppMinimized,
}: PaneStateFields): PaneState {
  const conversation = conversationSurface(conversationId);

  if (appId === null || !isAppMainView(mainView)) {
    return { presentation: "single", primary: conversation, secondary: null };
  }

  const app: PaneSurface = { kind: "app", id: appId };

  // Parked to its strip, the app is what waits and the conversation has the
  // room. Every other arrangement is the other way round.
  const parked = isAppMinimized && mainView !== "app-editing";
  const primary = parked ? conversation : app;
  const secondary = parked ? app : conversationSurface(boundConversationId);

  if (primary === null || secondary === null) {
    return {
      presentation: "single",
      primary: primary ?? secondary,
      secondary: null,
    };
  }

  return {
    presentation:
      mainView === "app-editing" ? "side" : parked ? "bottom" : "full",
    primary,
    secondary,
  };
}
