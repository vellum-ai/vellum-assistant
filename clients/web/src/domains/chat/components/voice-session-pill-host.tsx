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
 * Visibility is the exact complement of the owning-composer voice surface — the
 * one the full-screen voice room also renders against — so that in the main
 * window, for any active session, exactly one of {room, voice bar, pill} is
 * the visible control. The room and the pill both derive from the shared
 * {@link useOwningComposerSurfaceVisible} predicate (session active AND the
 * on-screen composer owns it): the pill shows when a session is active and it
 * is `false`; the room when it is `true`, this is the main window, and the
 * room is not minimized. Because the pill keys off that primitive alone — not
 * the room's own `!isPopout` / `!roomMinimized` gates — a headerless
 * pop-out's standalone pill still hides while the composer's voice bar owns
 * the session, and minimizing the room on the owning thread hands control to
 * the voice bar underneath, not the pill — no double control. Concretely, the
 * pill shows when:
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
 * without a navigation target, leaving its waves inert rather than a dead
 * button.
 *
 * A `failed` session unmounts the pill (no longer active), but the failure
 * must not vanish silently: when no composer is on screen to render its
 * failure `Notice` (see `chat-composer.tsx`), this host renders a dismissible
 * `VoiceSessionErrorChip` in the same slot instead. On composer routes the
 * chip stays hidden — the composer's Notice owns the error there — so the
 * two error surfaces never double-render. Dismissing the chip resets the
 * store to idle, mirroring the composer Notice's dismiss.
 *
 * The ■ "stop response" control is wired only for hands-free sessions, where
 * the client interrupt is turn-scoped (the daemon cancels the turn and
 * re-arms). A manual session's `interrupt()` ends the whole session,
 * contradicting the control's "without ending the session" contract, so
 * there the pill offers only ✕ (end).
 *
 * The pill is textless and takes no thread title, so nothing here resolves
 * the owning conversation row. Only `conversationId` matters, and only to
 * decide whether the waves navigate.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";
import type { ReactNode } from "react";

import { navigateToConversation } from "@/utils/conversation-navigation";

import {
  VoiceSessionErrorChip,
  VoiceSessionPill,
} from "@/domains/chat/components/voice-session-pill";
import { useComposerOnScreen } from "@/domains/chat/hooks/use-composer-on-screen";
import {
  LIVE_VOICE_STATE_LABELS,
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  isLiveVoiceSessionActive,
  setLiveVoiceMuted,
  stopLiveVoiceResponse,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useOwningComposerSurfaceVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { resolveWaveAccentHex } from "@/domains/chat/voice/voice-room/wave-accent";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

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

/**
 * Whether this host renders anything — an active-session pill, or the failure
 * chip that replaces it.
 *
 * Exported so the header can size its right cluster against a *live* session
 * without re-deriving the rules (`ChatLayoutHeader` collapses its other
 * controls behind an overflow menu once the pill occupies the row). The host
 * consumes the same hook, so the two can never disagree about whether the
 * slot is occupied.
 */
export function useVoiceSessionPillPresence(): {
  visible: boolean;
  showFailure: boolean;
} {
  const state = useLiveVoiceStore.use.state();
  const error = useLiveVoiceStore.use.error();
  const composerOnScreen = useComposerOnScreen();
  const owningSurfaceVisible = useOwningComposerSurfaceVisible();
  return {
    visible: isLiveVoiceSessionActive(state) && !owningSurfaceVisible,
    showFailure: state === "failed" && error !== null && !composerOnScreen,
  };
}

export function VoiceSessionPillHost({
  variant = "header",
}: VoiceSessionPillHostProps) {
  const state = useLiveVoiceStore.use.state();
  const error = useLiveVoiceStore.use.error();
  const sessionAssistantId = useLiveVoiceStore.use.assistantId();
  const sessionConversationId = useLiveVoiceStore.use.conversationId();
  const muted = useLiveVoiceStore.use.muted();
  // Turn-scoped ■ stop is hands-free-only: a manual (version-skew fallback)
  // session's interrupt ends the whole session, contradicting the control's
  // "without ending the session" contract — there the ✕ is the only stop.
  const handsFree = useLiveVoiceStore.use.handsFree();

  const navigate = useNavigate();

  // Both flags come from the shared hook above:
  //
  // - `visible` is the exact complement of the owning-composer voice surface —
  //   the pill shows for an active session precisely when that surface is NOT
  //   on screen. This is the room's popout-free core, so in a pop-out the pill
  //   still hides while the composer's voice bar owns the session.
  // - `showFailure` is the exact complement of the composer's failure Notice,
  //   which any on-screen voice-enabled composer renders regardless of
  //   ownership. Its `useComposerOnScreen` predicate is the strict one:
  //   conversation subroutes like the inspector
  //   (`/assistant/conversations/:id/inspect`) render no composer, so the
  //   chip must stay up there even for the owning conversation.
  const { visible, showFailure } = useVoiceSessionPillPresence();

  // Wave accent for the pill's listening waves — the same avatar-matched tint
  // the room resolves (see wave-accent.ts). Fetch-gated to a visible pill;
  // the query is shared with every other avatar consumer.
  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarCustomImageUrl,
  } = useAssistantAvatar(visible ? sessionAssistantId : null);
  const waveAccentHex = resolveWaveAccentHex(
    avatarComponents,
    avatarTraits,
    avatarCustomImageUrl,
  );

  const handleNavigate = useCallback(() => {
    if (sessionConversationId) {
      navigateToConversation(navigate, sessionConversationId);
    }
  }, [navigate, sessionConversationId]);

  let content: ReactNode = null;
  // `showFailure` already implies a non-null `error`; repeating the check here
  // is what re-narrows the type for the chip, since the flag now arrives from
  // the shared hook rather than an inline comparison.
  if (showFailure && error !== null) {
    content = (
      <VoiceSessionErrorChip
        message={error}
        onDismiss={dismissLiveVoiceFailure}
      />
    );
  } else if (visible) {
    content = (
      <VoiceSessionPill
        primaryLabel={muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
        state={state}
        getAmplitude={getLiveVoiceInputAmplitude}
        muted={muted}
        onToggleMute={() => setLiveVoiceMuted(!muted)}
        onStop={handsFree ? stopLiveVoiceResponse : undefined}
        onEnd={endLiveVoiceSession}
        onNavigate={sessionConversationId ? handleNavigate : undefined}
        waveAccentHex={waveAccentHex}
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
