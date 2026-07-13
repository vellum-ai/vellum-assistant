/**
 * Single source of truth for whether the full-screen live-voice room is
 * visible.
 *
 * The room is the owning-composer's voice surface: it shows exactly when a
 * session is active AND the composer currently on screen owns it AND the user
 * has not minimized it AND this is the main window (never a pop-out — see
 * below). Its popout-free core, {@link useOwningComposerSurfaceVisible}, is the
 * precise complement of the title-bar session pill, whose host consumes that
 * primitive's negation (`sessionActive && !owningSurfaceVisible`) so the two
 * surfaces can never both render — or both hide — for an active owned session.
 * (While minimized, the owning composer's voice bar — always rendered under
 * the room — is the visible session surface, so the pill stays hidden.)
 *
 * The inputs mirror {@link VoiceSessionPillHost} one-for-one:
 * - `composerOnScreen` — shared via {@link useComposerOnScreen}: a conversation
 *   chat route is mounted and not covered by the desktop fullscreen app viewer
 *   (mobile's app view keeps the composer mounted under a portal).
 * - `activeComposerOwnsSession` — the on-screen composer's conversation owns
 *   the session (`isLiveVoiceSessionOwnedBy`), covering the draft case too.
 *
 * Pop-outs: the room is a `fixed inset-0` overlay, so in an Electron pop-out
 * thread window it would cover the `variant="standalone"` pill that headerless
 * pop-outs rely on. Pop-outs therefore never show the room — the standalone
 * pill is their only session surface — so the room predicate ANDs in
 * `!isPopout`. The pill keeps its own popout-free complement
 * ({@link useOwningComposerSurfaceVisible}), so in a pop-out it still hides
 * while the composer's voice bar owns the session (no double control).
 *
 * Deliberately does NOT re-check the `voice-mode` flag: entry already gated the
 * session, and a live session keeps its UI even if the flag later flips (the
 * mid-session-eligibility-drop invariant).
 */

import { useState } from "react";
import { useLocation } from "react-router";

import { isPopoutWindow } from "@/runtime/popout-window";

import { useComposerOnScreen } from "@/domains/chat/hooks/use-composer-on-screen";
import {
  isLiveVoiceSessionActive,
  useIsLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Whether the owning composer's voice surface is currently on screen for the
 * active session — session active AND the on-screen composer owns it. The
 * popout-free primitive shared by the room and the pill: the room adds the
 * main-window gate ({@link useIsVoiceRoomVisible}); the pill shows for an active
 * session precisely when this is `false`.
 */
export function useOwningComposerSurfaceVisible(): boolean {
  const state = useLiveVoiceStore.use.state();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const composerOnScreen = useComposerOnScreen();
  const activeComposerOwnsSession =
    useIsLiveVoiceSessionOwnedBy(activeConversationId);

  return (
    isLiveVoiceSessionActive(state) &&
    composerOnScreen &&
    activeComposerOwnsSession
  );
}

/**
 * Whether the voice room should render. See the module docstring for the
 * complement contract with the title-bar session pill and the pop-out
 * exclusion.
 *
 * Also ANDs in `!roomMinimized`: minimizing (Escape / the room's minimize
 * control) hides the room while the session stays live. The owning composer's
 * voice bar — which always renders under the room for an owned session — then
 * becomes the visible session surface, so `useOwningComposerSurfaceVisible`
 * (and therefore the pill) deliberately ignores the flag: an owned, on-screen,
 * minimized session is controlled from the voice bar, not the pill.
 */
export function useIsVoiceRoomVisible(): boolean {
  const owningSurfaceVisible = useOwningComposerSurfaceVisible();
  const roomMinimized = useLiveVoiceStore.use.roomMinimized();
  const location = useLocation();
  // Capture pop-out mode once at mount: pop-out URLs carry `?popout=1` only on
  // the window's initial load (in-window navigation drops the query), and this
  // hook is consumed at persistent layout scope, so the mount-time value is the
  // window's lifetime value — mirroring `ChatLayout`'s own capture.
  const [isPopout] = useState(() => isPopoutWindow(location.search));

  return owningSurfaceVisible && !roomMinimized && !isPopout;
}
