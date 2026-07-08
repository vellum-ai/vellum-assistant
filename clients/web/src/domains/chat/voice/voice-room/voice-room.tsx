/**
 * Full-screen "voice room" — the owning-composer surface for a live-voice
 * session. A deep-dark ambient void with the assistant's state-driven avatar at
 * its center, mounted at layout scope (see `chat-layout.tsx`) as a purely
 * additive overlay: the composer's voice bar and display transcript still
 * render underneath, hidden by this layer, so removing the room leaves the old
 * UI intact.
 *
 * Visibility is a pure function of {@link useIsVoiceRoomVisible} — the exact
 * complement of the title-bar session pill. Any session end (user exit, Escape,
 * `failed`, conversation timeout, stop from elsewhere) flips that predicate
 * false and unmounts the room; a `failed` session surfaces through the existing
 * composer Notice / pill failure chip, never a dead room.
 *
 * Exit is first-class: a persistent ✕ control (always rendered, even while the
 * avatar/assistant data is loading or failed), plus global Escape (end) and
 * Space (push-to-talk "send now" fallback while idle/listening) key handlers
 * attached only while the room is mounted.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { isEditableTarget } from "@/hooks/use-edge-swipe";

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  liveVoiceStateLabel,
  releaseLiveVoiceTurn,
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

/**
 * Avatar entry spring: rises from a smaller, lower offset to center with a
 * slight overshoot. Mirrors the app's `NODE_SPRING` overshoot convention
 * (defined locally to avoid a cross-domain import, as `voice-avatar.tsx` does).
 */
const AVATAR_ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 200,
  damping: 18,
};

const AVATAR_SIZE = 220;
/** The one-time "how to speak" hint auto-dismisses after this long. */
const HINT_TIMEOUT_MS = 6000;

/** Whether Space / an orb tap should release the current turn in `state`. */
function canReleaseTurn(state: LiveVoiceSessionState): boolean {
  return state === "idle" || state === "listening";
}

export function VoiceRoom() {
  const visible = useIsVoiceRoomVisible();

  return (
    <AnimatePresence>{visible ? <VoiceRoomOverlay key="voice-room" /> : null}</AnimatePresence>
  );
}

/**
 * The mounted room. Split from {@link VoiceRoom} so its store subscriptions,
 * key handlers, and hint timer only exist while the room is actually visible
 * and are torn down cleanly on exit.
 */
function VoiceRoomOverlay() {
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const reduce = useReducedMotion();

  const visual = toVoiceAvatarVisual(state, reconnecting);
  const stateLabel = liveVoiceStateLabel(state, reconnecting);

  const [hintVisible, setHintVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setHintVisible(false), HINT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Global exit / push-to-talk keys, live only while the room is mounted.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        endLiveVoiceSession();
        return;
      }
      if (event.key === " " || event.code === "Space") {
        if (canReleaseTurn(useLiveVoiceStore.getState().state)) {
          event.preventDefault();
          releaseLiveVoiceTurn();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Tapping the orb is the pointer equivalent of the Space push-to-talk
  // fallback — "send now" while listening.
  const handleOrbTap = useCallback(() => {
    if (canReleaseTurn(useLiveVoiceStore.getState().state)) {
      releaseLiveVoiceTurn();
    }
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
      data-theme="dark"
      role="dialog"
      aria-modal="true"
      aria-label="Voice session"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.4 }}
    >
      <VoiceRoomAmbientBackground />

      {/* Persistent exit control — rendered above all room chrome and never
          gated behind avatar readiness, so exit works even mid-load / on
          failure. */}
      <button
        type="button"
        onClick={endLiveVoiceSession}
        aria-label="Exit voice session"
        className="absolute right-5 top-5 z-10 flex size-10 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
      >
        <X className="size-5" />
      </button>

      <div className="relative z-0 flex flex-col items-center gap-8">
        <motion.button
          type="button"
          onClick={handleOrbTap}
          aria-label="Speak"
          className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/50"
          initial={reduce ? false : { scale: 0.8, y: 24, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          transition={reduce ? { duration: 0 } : AVATAR_ENTER_SPRING}
        >
          <VoiceAvatar
            assistantId={assistantId}
            visual={visual}
            getAmplitude={getLiveVoiceInputAmplitude}
            size={AVATAR_SIZE}
          />
        </motion.button>

        {hintVisible ? (
          <p className="text-sm text-white/45">
            Tap the orb or press space to speak
          </p>
        ) : null}
      </div>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen. */}
      <div aria-live="polite" className="sr-only">
        {stateLabel}
      </div>
    </motion.div>
  );
}
