/**
 * Store-wiring host for the title-bar voice-session pill (Light 54).
 *
 * Mounted once by `ChatLayout` — composed directly with the header's
 * `topBarRightSlot` content rather than registered through
 * `useChatLayoutSlotsStore`, because slot registration is owned by per-route
 * hooks that unmount on navigation, which is exactly when the pill must
 * persist.
 *
 * Visibility is the exact complement of the composer's voice bar so that for
 * any active session exactly one of the two surfaces renders: the pill shows
 * whenever a session is active AND the composer currently on screen (if any)
 * does not own it (`isLiveVoiceSessionOwnedBy`). Concretely, the pill shows
 * when:
 *
 * - the user is viewing a different conversation than the session's,
 * - the user is off the conversation routes entirely (Home, Library, …) —
 *   `activeConversationId` deliberately persists across route changes (see
 *   `chat-layout.tsx`), so the id comparison alone can't detect this,
 * - the desktop fullscreen app viewer covers the thread (`mainView === "app"`;
 *   on mobile that view keeps the composer mounted under a portal overlay
 *   that covers the header too, so the composer stays the owning surface).
 *   `app-editing` (split view) and the right-drawer detail panels keep the
 *   composer visible, so they don't count.
 *
 * A session not yet attached to a conversation (started from a draft, before
 * the server's `ready` frame) still shows the pill when the user is away from
 * the owning composer — a live mic must always have a visible control — just
 * without a thread name or navigation target.
 *
 * The ■ "stop response" control is deliberately not wired: V1's `interrupt()`
 * ends the whole session, contradicting the control's "without ending the
 * session" contract, so the pill offers only ✕ (end) until a turn-scoped
 * interrupt exists (engine plan, JARVIS-1240).
 */

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { isConversationPath } from "@/utils/routes";

import { STATE_LABELS } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import { VoiceSessionPill } from "@/domains/chat/components/voice-session-pill";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import {
  isLiveVoiceSessionActive,
  useIsLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

export function VoiceSessionPillHost() {
  const state = useLiveVoiceStore.use.state();
  const sessionAssistantId = useLiveVoiceStore.use.assistantId();
  const sessionConversationId = useLiveVoiceStore.use.conversationId();
  const controls = useLiveVoiceStore.use.controls();

  const activeConversationId = useConversationStore.use.activeConversationId();
  const mainView = useViewerStore.use.mainView();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  const sessionActive = isLiveVoiceSessionActive(state);
  // Mirror of `chat-content-layout.tsx`: the desktop `app` view replaces
  // `ChatMainPanel` (composer included); every other view — and mobile's
  // portal-overlay `app` view — keeps the composer mounted.
  const composerOnScreen =
    isConversationPath(location.pathname) && !(mainView === "app" && !isMobile);
  // Same ownership predicate the composer's voice bar uses, evaluated for the
  // composer currently on screen — keeps the two surfaces exact complements.
  const activeComposerOwnsSession =
    useIsLiveVoiceSessionOwnedBy(activeConversationId);
  const visible =
    sessionActive && !(composerOnScreen && activeComposerOwnsSession);

  // Resolves the owning row from whichever list cache holds it, fetching the
  // single row when absent. Enabled only while the pill is shown so hidden
  // states cost nothing.
  const owningConversation = useActiveConversation(
    sessionAssistantId,
    sessionConversationId,
    visible && sessionConversationId !== null,
  );

  // Stable poll function — the waveform samples ~30 Hz via its draw loop, so
  // amplitude must not flow through props/re-renders (same pattern as the
  // composer's voice bar wiring).
  const getAmplitude = useCallback(
    () => useLiveVoiceStore.getState().inputAmplitude,
    [],
  );

  const handleNavigate = useCallback(() => {
    if (sessionConversationId) {
      navigateToConversation(navigate, sessionConversationId);
    }
  }, [navigate, sessionConversationId]);

  const handleEnd = useCallback(() => controls?.stop(), [controls]);
  const handleSend = useCallback(() => controls?.release(), [controls]);

  if (!visible) {
    return null;
  }

  return (
    <VoiceSessionPill
      primaryLabel={STATE_LABELS[state]}
      secondaryLabel={
        owningConversation ? (owningConversation.title ?? "Untitled") : undefined
      }
      state={state}
      getAmplitude={getAmplitude}
      onEnd={handleEnd}
      onSend={handleSend}
      onNavigate={sessionConversationId ? handleNavigate : undefined}
    />
  );
}
