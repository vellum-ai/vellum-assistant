/**
 * Whether the conversation composer (its voice bar included) is currently the
 * on-screen surface.
 *
 * True when a conversation chat route is mounted AND it is not covered by the
 * desktop fullscreen app viewer. Mirrors the render decision in
 * `chat-content-layout.tsx`: the desktop `app` view replaces `ChatMainPanel`
 * (composer included), while every other view — and mobile's portal-overlay
 * `app` view — keeps the composer mounted. The strict chat predicate
 * (`isConversationChatPath`) matters because conversation subroutes like the
 * inspector (`/assistant/conversations/:id/inspect`) render no composer.
 *
 * Extracted so the two live-voice surfaces that gate on it — the full-screen
 * voice room ({@link useIsVoiceRoomVisible}) and the title-bar session pill
 * ({@link VoiceSessionPillHost}) — derive the predicate from one place and can
 * never drift.
 */

import { useLocation } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { isConversationChatPath } from "@/utils/routes";

import { useViewerStore } from "@/stores/viewer-store";

export function useComposerOnScreen(): boolean {
  const mainView = useViewerStore.use.mainView();
  const isMobile = useIsMobile();
  const location = useLocation();

  return (
    isConversationChatPath(location.pathname) &&
    !(mainView === "app" && !isMobile)
  );
}
