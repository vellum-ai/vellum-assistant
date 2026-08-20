/**
 * Which surface sits in each pane.
 *
 * A surface is a kind and the id of the thing it shows. The workspace holds a
 * primary, which has the room, and at most one secondary, which shares it or
 * waits collapsed beside it.
 *
 * Which surface takes which pane is not fixed by kind. An app beside a
 * conversation has the room and the conversation shares it; an app parked to
 * its strip has given the room to the conversation and waits there itself. The
 * pair below says which is which, so no caller has to work it out from the
 * arrangement.
 */

import {
  isAppMainView,
  type PanePresentation,
} from "@/stores/pane-presentation";
import type { MainView } from "@/stores/viewer-store";

export type PaneSurface =
  | { kind: "conversation"; id: string }
  | { kind: "app"; id: string };

export interface PaneSurfaces {
  primary: PaneSurface | null;
  secondary: PaneSurface | null;
}

export interface PaneSurfaceFields {
  mainView: MainView;
  /** The app the viewer holds, if any. */
  appId: string | null;
  /** The conversation the workspace is loaded on. */
  conversationId: string | null;
  /** The conversation bound to the pane beside the app. */
  boundConversationId: string | null;
  isAppMinimized: boolean;
}

/**
 * Read the stored fields as the pair of surfaces they describe.
 *
 * With no app, the conversation has the workspace to itself and there is no
 * secondary. With one, the arrangement decides the order: parked to its strip
 * the app is the secondary, and in every other arrangement it is the primary
 * and the conversation is what shares or waits.
 */
export function paneSurfaces({
  mainView,
  appId,
  conversationId,
  boundConversationId,
  isAppMinimized,
}: PaneSurfaceFields): PaneSurfaces {
  const conversation: PaneSurface | null =
    conversationId === null
      ? null
      : { kind: "conversation", id: conversationId };

  if (appId === null || !isAppMainView(mainView)) {
    return { primary: conversation, secondary: null };
  }

  const app: PaneSurface = { kind: "app", id: appId };
  const bound: PaneSurface | null =
    boundConversationId === null
      ? null
      : { kind: "conversation", id: boundConversationId };

  // Side by side is read before the strip, matching the arrangement. The
  // fields can hold both at once, and an app cannot be beside a conversation
  // and parked below it, so one of them has to be the answer.
  if (mainView === "app-editing") {
    return { primary: app, secondary: bound };
  }
  if (isAppMinimized) {
    return { primary: conversation, secondary: app };
  }
  return { primary: app, secondary: bound };
}

/**
 * Whether an arrangement shows the secondary, as opposed to holding it
 * collapsed. `"full"` keeps its secondary and shows one surface, which is the
 * difference between a pane a click away and one that is gone.
 */
export function showsSecondary(presentation: PanePresentation): boolean {
  return presentation === "side" || presentation === "bottom";
}
