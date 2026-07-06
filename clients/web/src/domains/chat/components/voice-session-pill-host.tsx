/**
 * Store-wiring host for the title-bar voice-session pill (Light 54).
 *
 * Mounted once by `ChatLayout` — composed directly with the header's
 * `topBarRightSlot` content rather than registered through
 * `useChatLayoutSlotsStore`, because slot registration is owned by per-route
 * hooks that unmount on navigation, which is exactly when the pill must
 * persist.
 *
 * Renders `VoiceSessionPill` only while a live-voice session is active AND
 * the owning conversation's composer is not the current surface, i.e. when
 * any of these hold:
 *
 * - the user is viewing a different conversation,
 * - the user is off the conversation routes entirely (Home, Library, …) —
 *   `activeConversationId` deliberately persists across route changes (see
 *   `chat-layout.tsx`), so the id comparison alone can't detect this,
 * - the fullscreen app viewer covers the thread (`mainView === "app"`).
 *   `app-editing` (split view) and the right-drawer detail panels keep the
 *   composer visible, so they don't count.
 *
 * A session with no owning conversation (started from an unsent draft) has
 * no thread to return to, so the pill stays hidden for it.
 */

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { STATE_LABELS } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import { VoiceSessionPill } from "@/domains/chat/components/voice-session-pill";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/** Routes where ChatPage mounts the active conversation's composer. */
function isConversationRoute(pathname: string): boolean {
  return (
    pathname === routes.assistant ||
    pathname === `${routes.assistant}/` ||
    pathname.startsWith(`${routes.conversations}/`)
  );
}

export function VoiceSessionPillHost() {
  const state = useLiveVoiceStore.use.state();
  const sessionAssistantId = useLiveVoiceStore.use.assistantId();
  const sessionConversationId = useLiveVoiceStore.use.conversationId();
  const controls = useLiveVoiceStore.use.controls();

  const activeConversationId = useConversationStore.use.activeConversationId();
  const mainView = useViewerStore.use.mainView();
  const location = useLocation();
  const navigate = useNavigate();

  const sessionActive = state !== "idle" && state !== "failed";
  const viewingOwningComposer =
    sessionConversationId !== null &&
    sessionConversationId === activeConversationId &&
    isConversationRoute(location.pathname) &&
    mainView !== "app";
  const visible =
    sessionActive && sessionConversationId !== null && !viewingOwningComposer;

  // Resolves the owning row from whichever list cache holds it, fetching the
  // single row when absent. Enabled only while the pill is shown so hidden
  // states cost nothing.
  const owningConversation = useActiveConversation(
    sessionAssistantId,
    sessionConversationId,
    visible,
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

  const handleStop = useCallback(() => controls?.interrupt(), [controls]);
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
      onStop={handleStop}
      onEnd={handleEnd}
      onSend={handleSend}
      onNavigate={handleNavigate}
    />
  );
}
