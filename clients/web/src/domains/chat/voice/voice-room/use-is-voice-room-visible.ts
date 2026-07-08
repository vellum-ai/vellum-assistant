/**
 * Single source of truth for whether the full-screen live-voice room is
 * visible.
 *
 * The room is the owning-composer's voice surface: it shows exactly when a
 * session is active AND the composer currently on screen owns it. That is the
 * precise complement of the title-bar session pill, whose host consumes this
 * hook's negation (`sessionActive && !voiceRoomVisible`) so the two surfaces
 * can never both render — or both hide — for an active owned session.
 *
 * The inputs mirror {@link VoiceSessionPillHost} one-for-one:
 * - `composerOnScreen` — a conversation chat route is mounted and not covered
 *   by the desktop fullscreen app viewer (mobile's app view keeps the composer
 *   mounted under a portal). Matches `chat-content-layout.tsx`.
 * - `activeComposerOwnsSession` — the on-screen composer's conversation owns
 *   the session (`isLiveVoiceSessionOwnedBy`), covering the draft case too.
 *
 * Deliberately does NOT re-check the `voice-mode` flag: entry already gated the
 * session, and a live session keeps its UI even if the flag later flips (the
 * mid-session-eligibility-drop invariant).
 */

import { useLocation } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { isConversationChatPath } from "@/utils/routes";

import {
  isLiveVoiceSessionActive,
  useIsLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Whether the full-screen voice room should render. See the module docstring
 * for the exact-complement contract with the title-bar session pill.
 */
export function useIsVoiceRoomVisible(): boolean {
  const state = useLiveVoiceStore.use.state();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const mainView = useViewerStore.use.mainView();
  const isMobile = useIsMobile();
  const location = useLocation();

  const composerOnScreen =
    isConversationChatPath(location.pathname) &&
    !(mainView === "app" && !isMobile);
  const activeComposerOwnsSession =
    useIsLiveVoiceSessionOwnedBy(activeConversationId);

  return (
    isLiveVoiceSessionActive(state) &&
    composerOnScreen &&
    activeComposerOwnsSession
  );
}
