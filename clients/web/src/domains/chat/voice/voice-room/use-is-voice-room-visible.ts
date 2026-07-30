/**
 * Single source of truth for whether the live-voice room is visible. (Placement
 * is the room's own concern: an inset panel on desktop, full-screen on mobile.
 * See `voice-room.tsx`.)
 *
 * The room is the owning-composer's voice surface: it shows exactly when a
 * session is active AND the composer currently on screen owns it AND this is
 * the main window (never a pop-out — see below) AND the room is not
 * minimized. Minimizing (the room's − control, Escape, or an
 * assistant-driven `minimize_room` frame) dismisses the room while the
 * session stays live: the composer's voice bar covers the session on the
 * owning thread and the title-bar pill everywhere else, per the complement
 * rules below. Its popout-free core, {@link useOwningComposerSurfaceVisible},
 * is the precise complement of the title-bar session pill, whose host
 * consumes that primitive's negation (`sessionActive &&
 * !owningSurfaceVisible`) so the two surfaces can never both render — or both
 * hide — for an active owned session. `roomMinimized` deliberately stays OUT
 * of that shared primitive: with the owning composer on screen and the room
 * minimized, the composer's voice bar (not the pill) is the session control —
 * the same complement a pop-out uses — so folding the minimize gate into the
 * primitive would wrongly summon the pill on top of the voice bar.
 *
 * The inputs mirror {@link VoiceSessionPillHost} one-for-one:
 * - `composerOnScreen` — shared via {@link useComposerOnScreen}: a conversation
 *   chat route is mounted and not covered by the desktop fullscreen app viewer
 *   (mobile's app view keeps the composer mounted under a portal).
 * - `activeComposerOwnsSession` — the on-screen composer's conversation owns
 *   the session (`isLiveVoiceSessionOwnedBy`), covering the draft case too.
 *
 * Pop-outs: the room fills whichever box it is mounted in, so in an Electron
 * pop-out thread window it would cover the `variant="standalone"` pill that
 * headerless pop-outs rely on. Insetting it to the content area does not help,
 * because the content area is the whole pop-out. Pop-outs therefore never show
 * the room. The standalone
 * pill is their only session surface — so the room predicate ANDs in
 * `!isPopout`. The pill keeps its own popout-free complement
 * ({@link useOwningComposerSurfaceVisible}), so in a pop-out it still hides
 * while the composer's voice bar owns the session (no double control).
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
 * complement contract with the title-bar session pill, the pop-out
 * exclusion, and the minimize gate.
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

  return owningSurfaceVisible && !isPopout && !roomMinimized;
}
