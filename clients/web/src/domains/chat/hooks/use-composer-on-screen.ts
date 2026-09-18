/**
 * Whether the conversation composer (its voice bar included) is currently the
 * on-screen surface.
 *
 * True when a conversation chat route is mounted AND it is not covered by the
 * desktop fullscreen app viewer. The cover is read through
 * {@link showsFullWidthApp}, the same predicate `chat-content-layout.tsx`
 * renders that branch on, so the two cannot drift: an app view holding no app
 * at all (a released app) draws the chat, composer included. The strict chat
 * predicate (`isConversationChatPath`) matters because conversation subroutes
 * like the inspector (`/assistant/conversations/:id/inspect`) render no
 * composer.
 *
 * Extracted so the two live-voice surfaces that gate on it — the full-screen
 * voice room ({@link useIsVoiceRoomVisible}) and the title-bar session pill
 * ({@link VoiceSessionPillHost}) — derive the predicate from one place and can
 * never drift.
 */

import { useLocation } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { isConversationChatPath } from "@/utils/routes";

import { showsFullWidthApp } from "@/stores/pane-state";
import { useViewerStore } from "@/stores/viewer-store";

export function useComposerOnScreen(): boolean {
  const mainView = useViewerStore.use.mainView();
  const activeAppId = useViewerStore.use.activeAppId();
  const openedAppState = useViewerStore.use.openedAppState();
  const isMobile = useIsMobile();
  const location = useLocation();

  return (
    isConversationChatPath(location.pathname) &&
    !showsFullWidthApp({
      mainView,
      isMobile,
      activeAppId,
      openedAppId: openedAppState?.appId ?? null,
    })
  );
}
