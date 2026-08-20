/**
 * Whether the transcript is on screen.
 *
 * The selected conversation is not the same as a visible one. It outlives the
 * route it was selected on, because the streams read the same field and need
 * it to, and even on its own route the viewer can put something over it.
 *
 * Anything that treats reading as having happened asks this rather than the
 * selection.
 */

import { isAppMainView, isOverlayView } from "@/stores/pane-state";
import { isConversationChatPath } from "@/utils/routes";
import type { MainView } from "@/stores/viewer-store";

export interface TranscriptVisibilityInput {
  pathname: string;
  mainView: MainView;
  isAppMinimized: boolean;
  /** Whether the viewport is narrow enough that the viewer takes the screen. */
  isNarrow: boolean;
}

export function isTranscriptOnScreen({
  pathname,
  mainView,
  isAppMinimized,
  isNarrow,
}: TranscriptVisibilityInput): boolean {
  // Conversation subroutes replace the transcript with something else: the
  // inspector renders in its place rather than beside it.
  if (!isConversationChatPath(pathname)) {
    return false;
  }
  // A full-width app takes the transcript's place. Minimized to its strip it
  // sits over a chat that is still readable, and the side-by-side layout
  // shows both.
  if (
    isAppMainView(mainView) &&
    mainView !== "app-editing" &&
    !isAppMinimized
  ) {
    return false;
  }
  // Documents, tool details and the rest are drawers beside the chat on a
  // wide viewport and full-screen overlays on a narrow one.
  return !(isNarrow && isOverlayView(mainView));
}
