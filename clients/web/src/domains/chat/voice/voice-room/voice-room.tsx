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

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  liveVoiceStateLabel,
  releaseLiveVoiceTurn,
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { AVATAR_ENTER_SPRING } from "./voice-motion";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

const AVATAR_SIZE = 220;
/** The one-time "how to speak" hint auto-dismisses after this long. */
const HINT_TIMEOUT_MS = 6000;

/**
 * Safe-area insets (see `docs/CAPACITOR.md`): the `var()` is set by
 * `capacitor-plugin-safe-area` on Capacitor iOS, `env()` covers standard
 * browsers with `viewport-fit=cover`, and `0px` covers desktop / non-notch
 * devices — so these are inert everywhere except a notched iOS shell.
 */
const SAFE_AREA_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
const SAFE_AREA_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";
const SAFE_AREA_LEFT =
  "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))";
const SAFE_AREA_RIGHT =
  "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))";

/** Whether Space / an orb tap should release the current turn in `state`. */
function canReleaseTurn(state: LiveVoiceSessionState): boolean {
  return state === "idle" || state === "listening";
}

/**
 * Whether the event target is (or sits within) an interactive control that
 * owns Space as its own activation — a button, link, or other focusable
 * control. The global Space push-to-talk shortcut must not swallow Space when
 * one of these (e.g. the focused exit ✕) has focus, or keyboard users can't
 * activate it. This is narrower than {@link isEditableTarget} (text fields);
 * Escape stays global regardless of focus.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      'button, a[href], [role="button"], [role="link"], select, [tabindex]:not([tabindex="-1"])',
    ) !== null
  );
}

/**
 * Whether the event target is a text-editable control (input / textarea /
 * select / contentEditable) that should keep Space for typing.
 *
 * Local copy of the canonical helper (kept in sync with
 * `use-push-to-talk.ts`); the previously-shared `use-edge-swipe` export was
 * removed on main, so this is colocated here rather than imported.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
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
      // Escape is a global exit — it must fire even when the composer textarea
      // (or any other editable/focused element) still holds focus as the room
      // opens, so it is handled before any target guard.
      if (event.key === "Escape") {
        event.preventDefault();
        endLiveVoiceSession();
        return;
      }
      if (event.key === " " || event.code === "Space") {
        // Space is push-to-talk; never steal it from a text field or a focused
        // interactive control (e.g. the exit ✕), which handle Space as their own
        // input/activation. The orb is itself a button, so Space over it still
        // releases via its onClick.
        if (isEditableTarget(event.target) || isInteractiveTarget(event.target)) {
          return;
        }
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
      // This `fixed inset-0` overlay covers `ChatLayoutHeader`, so it loses the
      // header's safe-area protection — pad the centered chrome (avatar, hint)
      // inside the notch/home-indicator per docs/CAPACITOR.md. The ambient
      // void is `absolute inset-0` and stays full-bleed behind the padding.
      style={{
        paddingTop: SAFE_AREA_TOP,
        paddingBottom: SAFE_AREA_BOTTOM,
        paddingLeft: SAFE_AREA_LEFT,
        paddingRight: SAFE_AREA_RIGHT,
      }}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.4 }}
    >
      <VoiceRoomAmbientBackground />

      {/* Optional muted echo of the live transcript, floating above (user) and
          below (assistant) the centered avatar. Pref-gated and absolutely
          positioned, so it never shifts the avatar and stays absent by default. */}
      <VoiceAmbientTranscript />

      {/* Persistent exit control — rendered above all room chrome and never
          gated behind avatar readiness, so exit works even mid-load / on
          failure. */}
      <button
        type="button"
        onClick={endLiveVoiceSession}
        aria-label="Exit voice session"
        // Absolute position is relative to the padding box, so the overlay's
        // safe-area padding does not shift this — inset it from the notch /
        // Dynamic Island directly, clamped to the desktop 1.25rem gap.
        style={{
          top: `max(1.25rem, ${SAFE_AREA_TOP})`,
          right: `max(1.25rem, ${SAFE_AREA_RIGHT})`,
        }}
        className="absolute z-10 flex size-10 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
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
