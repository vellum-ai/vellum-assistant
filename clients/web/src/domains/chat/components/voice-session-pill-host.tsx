/**
 * Store-wiring host for the off-conversation voice-session surface (Light 736
 * desktop, Light 743 mobile).
 *
 * Mounted once by `ChatLayout` — composed directly with the header's
 * `topBarRightSlot` content rather than registered through
 * `useChatLayoutSlotsStore`, because slot registration is owned by per-route
 * hooks that unmount on navigation, which is exactly when the pill must
 * persist. A phone gets the same surface as its own full-width row above the
 * header (`variant="row"`) instead, since a phone header has no width for a
 * pill beside the centre title. Electron pop-out thread windows render no
 * header at all, so `ChatLayout` mounts a third host there with
 * `variant="standalone"`, which floats the surface over the window's top-right
 * corner: a session carried to another conversation via in-window switching
 * (Cmd+Up/Down) must still have a visible control.
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
 * without a navigation target, leaving the band's middle inert rather than a
 * dead button.
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
 * The pill says what the session is doing, not which thread it belongs to, so
 * nothing here resolves the owning conversation row. Only `conversationId`
 * matters, and only to decide whether the band's middle navigates.
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
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  isLiveVoiceSessionActive,
  liveVoiceSurfaceLabelKey,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useOwningComposerSurfaceVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { useVoiceSurfacePaint } from "@/domains/chat/voice/voice-room/use-voice-surface-paint";
import { useTranslation } from "@/i18n";

export interface VoiceSessionPillHostProps {
  /**
   * Placement variant, all rendering nothing when there is neither an active
   * session to control nor a failure to surface.
   *
   * - `"header"` (default): the elongated pill, for composition into the
   *   header's right cluster on a desktop-width window.
   * - `"row"`: the full-bleed band a phone lays out above the thread header,
   *   where the header row has no width to give a pill.
   * - `"standalone"`: floats the pill over the window's top-right corner, for
   *   windows without a header (Electron pop-out thread windows).
   */
  variant?: "header" | "row" | "standalone";
}

/**
 * Whether this host renders anything — an active-session pill, or the failure
 * chip that replaces it.
 */
function useVoiceSessionPillPresence(): {
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
  const { t } = useTranslation("chat");
  const state = useLiveVoiceStore.use.state();
  const error = useLiveVoiceStore.use.error();
  const sessionAssistantId = useLiveVoiceStore.use.assistantId();
  const sessionConversationId = useLiveVoiceStore.use.conversationId();
  const muted = useLiveVoiceStore.use.muted();
  const outputMuted = useLiveVoiceStore.use.outputMuted();

  // The session's own word, taken as a catalog key so the pill reads in the
  // user's language. This host observes neither the reconnect flag nor whether
  // assistant audio is flowing, so those two remaps are handed the values that
  // leave them unfired and what comes back is the phase's own word. Mute keeps
  // the branch below rather than being passed in: the pill says "Muted" in
  // every phase, not only the one the session relabels for it.
  const stateKey = liveVoiceSurfaceLabelKey(state, false, true, false);
  const stateLabel = stateKey ? t(stateKey) : "";

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

  // The room's fill for the pill to paint itself in, from the session
  // assistant's avatar, so the pill and the room are the same surface at two
  // sizes. Fetch-gated to a visible pill; the query is shared with every other
  // avatar consumer.
  const paint = useVoiceSurfacePaint(visible ? sessionAssistantId : null);

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
        primaryLabel={muted ? t("voiceSessionPillHost.muted") : stateLabel}
        state={state}
        getAmplitude={getLiveVoiceInputAmplitude}
        getOutputAmplitude={getLiveVoiceOutputAmplitude}
        muted={muted}
        onToggleMute={() => setLiveVoiceMuted(!muted)}
        outputMuted={outputMuted}
        onToggleOutputMute={() => setLiveVoiceOutputMuted(!outputMuted)}
        onEnd={endLiveVoiceSession}
        onNavigate={sessionConversationId ? handleNavigate : undefined}
        paint={paint}
        layout={variant === "row" ? "row" : "pill"}
      />
    );
  }

  if (content === null) {
    return null;
  }

  if (variant === "row") {
    // In flow above the thread header, so a live session pushes the page down
    // instead of covering any of it. The pill takes a small inset rather than
    // running into the screen edges: a shade tighter than the header's own
    // `px-4`, so the surface still reads as spanning the width. The failure
    // chip keeps the header's inset, plus the gap above that the pill gets
    // from the header's own top padding.
    return (
      <div className={showFailure ? "shrink-0 px-4 pt-2" : "shrink-0 px-2"}>
        {content}
      </div>
    );
  }

  if (variant === "standalone") {
    // Floats over the pop-out's content (which owns its own scrolling), so an
    // absolute corner anchor never disturbs layout. Both the pill and the error
    // chip carry their own fill, so the corner adds only a shadow to lift them
    // off the content.
    return (
      <div className="absolute right-4 top-4 z-30 rounded-full shadow-md">
        {content}
      </div>
    );
  }

  return content;
}
