/**
 * Store-wiring host for the title-bar voice-session pill (Light 54).
 *
 * Mounted once by `ChatLayout` — composed directly with the header's
 * `topBarRightSlot` content rather than registered through
 * `useChatLayoutSlotsStore`, because slot registration is owned by per-route
 * hooks that unmount on navigation, which is exactly when the pill must
 * persist. Electron pop-out thread windows render no header at all, so
 * `ChatLayout` mounts a second host there with `variant="standalone"`, which
 * floats the same surface over the window's top-right corner — a session
 * carried to another conversation via in-window switching (Cmd+Up/Down) must
 * still have a visible control.
 *
 * Visibility is the exact complement of the full-screen voice room — the
 * owning-composer surface — so that for any active session exactly one of the
 * two renders. Both derive from the shared {@link useIsVoiceRoomVisible}
 * predicate (session active AND the on-screen composer owns it): the room shows
 * when it is `true`, the pill when a session is active and it is `false`.
 * Concretely, the pill shows when:
 *
 * - the user is viewing a different conversation than the session's,
 * - the user is off the chat routes entirely (Home, Library, …) or on a
 *   composer-less conversation subroute like the inspector
 *   (`/assistant/conversations/:id/inspect`) — `activeConversationId`
 *   deliberately persists across route changes (see `chat-layout.tsx`), so
 *   the id comparison alone can't detect this,
 * - the desktop fullscreen app viewer covers the thread (`mainView === "app"`;
 *   on mobile that view keeps the composer — the owning surface — mounted,
 *   but under the `MobileAppOverlay` portal, which covers the composer AND
 *   the header, so neither surface is actually visible while the overlay is
 *   expanded. Accepted limitation: the mic stays hot with no on-screen
 *   control until the overlay closes or minimizes, at which point the
 *   composer's voice bar is the control again). `app-editing` (split view)
 *   and the right-drawer detail panels keep the composer visible, so they
 *   don't count.
 *
 * A session not yet attached to a conversation (started from a draft, before
 * the server's `ready` frame) still shows the pill when the user is away from
 * the owning composer — a live mic must always have a visible control — just
 * without a thread name or navigation target.
 *
 * A `failed` session unmounts the pill (no longer active), but the failure
 * must not vanish silently: when no composer is on screen to render its
 * failure `Notice` (see `chat-composer.tsx`), this host renders a dismissible
 * `VoiceSessionErrorChip` in the same slot instead. On composer routes the
 * chip stays hidden — the composer's Notice owns the error there — so the
 * two error surfaces never double-render. Dismissing the chip resets the
 * store to idle, mirroring the composer Notice's dismiss.
 *
 * The ■ "stop response" control is deliberately not wired: V1's `interrupt()`
 * ends the whole session, contradicting the control's "without ending the
 * session" contract, so the pill offers only ✕ (end) until a turn-scoped
 * interrupt exists (engine plan, JARVIS-1240).
 */

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { isConversationChatPath } from "@/utils/routes";

import {
  VoiceSessionErrorChip,
  VoiceSessionPill,
} from "@/domains/chat/components/voice-session-pill";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import {
  LIVE_VOICE_STATE_LABELS,
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  isLiveVoiceSessionActive,
  releaseLiveVoiceTurn,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useIsVoiceRoomVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { useViewerStore } from "@/stores/viewer-store";

export interface VoiceSessionPillHostProps {
  /**
   * Placement variant. `"header"` (default) renders the bare surface for
   * composition into the header's right slot. `"standalone"` floats it over
   * the window's top-right corner with its own chrome, for windows without a
   * header (Electron pop-out thread windows). Renders nothing either way when
   * there is neither an active session to control nor a failure to surface.
   */
  variant?: "header" | "standalone";
}

export function VoiceSessionPillHost({
  variant = "header",
}: VoiceSessionPillHostProps) {
  const state = useLiveVoiceStore.use.state();
  const error = useLiveVoiceStore.use.error();
  const sessionAssistantId = useLiveVoiceStore.use.assistantId();
  const sessionConversationId = useLiveVoiceStore.use.conversationId();

  const mainView = useViewerStore.use.mainView();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  const sessionActive = isLiveVoiceSessionActive(state);
  // Mirror of `chat-content-layout.tsx`: the desktop `app` view replaces
  // `ChatMainPanel` (composer included); every other view — and mobile's
  // portal-overlay `app` view — keeps the composer mounted. The strict chat
  // predicate matters: conversation subroutes like the inspector
  // (`/assistant/conversations/:id/inspect`) render no composer, so the pill
  // must stay up there even for the owning conversation. Retained here only for
  // the failure surface below — the pill's own visibility keys off the room.
  const composerOnScreen =
    isConversationChatPath(location.pathname) &&
    !(mainView === "app" && !isMobile);
  // Exact complement of the full-screen voice room (the owning-composer
  // surface): the pill shows for an active session precisely when the room does
  // not. Both read the one shared predicate so they can never drift.
  const voiceRoomVisible = useIsVoiceRoomVisible();
  const visible = sessionActive && !voiceRoomVisible;
  // Failure surface: exact complement of the composer's failure Notice, which
  // any on-screen voice-enabled composer renders regardless of ownership.
  const showFailure = state === "failed" && error !== null && !composerOnScreen;

  // Resolves the owning row from whichever list cache holds it, fetching the
  // single row when absent. Enabled only while the pill is shown so hidden
  // states cost nothing.
  const owningConversation = useActiveConversation(
    sessionAssistantId,
    sessionConversationId,
    visible && sessionConversationId !== null,
  );

  const handleNavigate = useCallback(() => {
    if (sessionConversationId) {
      navigateToConversation(navigate, sessionConversationId);
    }
  }, [navigate, sessionConversationId]);

  let content: ReactNode = null;
  if (showFailure) {
    content = (
      <VoiceSessionErrorChip message={error} onDismiss={dismissLiveVoiceFailure} />
    );
  } else if (visible) {
    content = (
      <VoiceSessionPill
        primaryLabel={LIVE_VOICE_STATE_LABELS[state]}
        secondaryLabel={
          owningConversation ? (owningConversation.title ?? "Untitled") : undefined
        }
        state={state}
        getAmplitude={getLiveVoiceInputAmplitude}
        onEnd={endLiveVoiceSession}
        onSend={releaseLiveVoiceTurn}
        onNavigate={sessionConversationId ? handleNavigate : undefined}
      />
    );
  }

  if (content === null) {
    return null;
  }

  if (variant === "standalone") {
    // Floats over the pop-out's content (which owns its own scrolling), so an
    // absolute corner anchor never disturbs layout. The pill needs chrome of
    // its own here — in the header the surrounding title bar provides it —
    // while the error chip already carries a filled background.
    return (
      <div className="absolute right-4 top-4 z-30">
        {showFailure ? (
          content
        ) : (
          <div className="rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] py-1 pl-4 pr-1.5 shadow-md">
            {content}
          </div>
        )}
      </div>
    );
  }

  return content;
}
