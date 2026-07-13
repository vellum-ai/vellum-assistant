/**
 * "Voice room" — the owning-composer surface for a live-voice session. A
 * deep-dark ambient void with the assistant's state-driven avatar at its
 * center, mounted by `chat-layout.tsx` as a purely additive overlay: the
 * composer's voice bar and display transcript still render underneath, hidden
 * by this layer, so removing the room leaves the old UI intact.
 *
 * Two placement variants (see `chat-layout.tsx` for the mounts):
 *
 * - `"fullscreen"` (mobile) — `fixed inset-0` over the whole viewport,
 *   modal, with safe-area padding for notched iOS shells.
 * - `"content"` (desktop) — `absolute inset-0` inside the layout's `<main>`,
 *   leaving the header and sidebar visible AND interactive so the user can
 *   keep navigating; any navigation away hands the session off to the
 *   title-bar pill. Deliberately not `aria-modal`: the surrounding chrome
 *   stays usable.
 *
 * Visibility is a pure function of {@link useIsVoiceRoomVisible} — active
 * session, owned by the on-screen composer, not minimized, main window. Any
 * session end (user exit, `failed`, conversation timeout, stop from elsewhere)
 * flips that predicate false and unmounts the room; a `failed` session
 * surfaces through the existing composer Notice / pill failure chip, never a
 * dead room.
 *
 * Sessions are hands-free (server-VAD): the user just speaks, so there is no
 * push-to-talk control — and deliberately no manual "send now" either: the
 * controller's `release` seam is a no-op for hands-free sessions, so such a
 * control would be dead (PR #37913 review). Exit is first-class: a persistent
 * ✕ control (always rendered, even while the avatar/assistant data is loading
 * or failed) ends the session; Escape and the minimize control collapse the
 * room to the composer's voice bar WITHOUT ending the session (the bar's
 * expand control reopens it). The key handler attaches only while the room is
 * mounted.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { Captions, CaptionsOff, Minimize2, X } from "lucide-react";

import { Tooltip, cn } from "@vellumai/design-library";

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  liveVoiceStateLabel,
  minimizeLiveVoiceRoom,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { resolveWaveAccentHex } from "./wave-accent";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceListeningWaves } from "./voice-listening-waves";
import { AVATAR_ENTER_SPRING } from "./voice-motion";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

const AVATAR_SIZE = 220;

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

/** Shared white-on-dark treatment for the room's icon controls. */
const ROOM_CONTROL_CLASS =
  "flex size-10 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60";

export type VoiceRoomVariant = "fullscreen" | "content";

export interface VoiceRoomProps {
  /** Placement variant — see the module docstring. Defaults to fullscreen. */
  variant?: VoiceRoomVariant;
}

export function VoiceRoom({ variant = "fullscreen" }: VoiceRoomProps) {
  const visible = useIsVoiceRoomVisible();

  return (
    <AnimatePresence>
      {visible ? <VoiceRoomOverlay key="voice-room" variant={variant} /> : null}
    </AnimatePresence>
  );
}

/**
 * The mounted room. Split from {@link VoiceRoom} so its store subscriptions and
 * key handlers only exist while the room is actually visible and are torn
 * down cleanly on exit.
 */
function VoiceRoomOverlay({ variant }: { variant: VoiceRoomVariant }) {
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const reduce = useReducedMotion();

  const visual = toVoiceAvatarVisual(state, reconnecting);
  const stateLabel = liveVoiceStateLabel(state, reconnecting);

  // Captions = the two persisted transcript prefs, toggled together from the
  // room. Bound to the same `voice-prefs` store as the settings page and the
  // first-run card, so a choice made here is the choice those surfaces show.
  const showUserTranscript = useVoicePrefsStore.use.showUserTranscript();
  const showAssistantTranscript =
    useVoicePrefsStore.use.showAssistantTranscript();
  const captionsOn = showUserTranscript || showAssistantTranscript;
  const toggleCaptions = () => {
    const prefs = useVoicePrefsStore.getState();
    prefs.setShowUserTranscript(!captionsOn);
    prefs.setShowAssistantTranscript(!captionsOn);
  };

  // Publish the session assistant's avatar accent on the room itself (not just
  // the html-level var, which tracks the *active* assistant) so the listening
  // waves tint to the avatar shown here even if a session outlives navigating
  // away. Shares the cached avatar query with VoiceAvatar; null for
  // custom-image / "none" / still-loading avatars, where the waves fall back to
  // the aurora indigo via the CSS var fallback.
  const { components, traits } = useAssistantAvatar(assistantId);
  const accentHex = resolveWaveAccentHex(components, traits);

  // Global Escape, live only while the room is mounted: minimizes the room
  // (the session keeps running; the composer's voice bar takes over as the
  // control surface) — ending is reserved for the explicit ✕. It fires even
  // when the composer textarea (or any other focused element) still holds
  // focus as the room opens, so it is intentionally not guarded by the event
  // target.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        minimizeLiveVoiceRoom();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <motion.div
      className={cn(
        "flex items-center justify-center overflow-hidden",
        // Both variants sit at z-50: the highest tier used inside the chat
        // content (e.g. the quote-reply bubble), with DOM order — the room
        // mounts after the Outlet — breaking the tie in the room's favor.
        variant === "fullscreen"
          ? "fixed inset-0 z-50"
          : "absolute inset-0 z-50 rounded-xl",
      )}
      data-theme="dark"
      role="dialog"
      // Only the fullscreen room is modal: the content variant deliberately
      // leaves the header and sidebar interactive so the user can navigate
      // mid-session (the pill takes over as the control surface).
      aria-modal={variant === "fullscreen" || undefined}
      aria-label="Voice session"
      // The fullscreen overlay covers `ChatLayoutHeader`, so it loses the
      // header's safe-area protection — pad the centered avatar inside the
      // notch/home-indicator per docs/CAPACITOR.md. Inert for the desktop
      // content variant. The ambient void is `absolute inset-0` and stays
      // full-bleed behind the padding.
      style={{
        paddingTop: SAFE_AREA_TOP,
        paddingBottom: SAFE_AREA_BOTTOM,
        paddingLeft: SAFE_AREA_LEFT,
        paddingRight: SAFE_AREA_RIGHT,
        ...(accentHex ? { [AVATAR_ACCENT_CSS_VAR]: accentHex } : {}),
      }}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.4 }}
    >
      <VoiceRoomAmbientBackground />

      {/* Listening waves: the user's voice arriving as energy coming in, rising
          from the bottom edge with live mic amplitude. Only while listening;
          responding expresses itself through the avatar's own emanation. Sits
          above the void, behind the centered avatar (later in DOM, z-0). */}
      {visual === "listening" ? (
        <VoiceListeningWaves
          getAmplitude={getLiveVoiceInputAmplitude}
          palette="accent"
        />
      ) : null}

      {/* Optional muted echo of the live transcript, floating above (user) and
          below (assistant) the centered avatar. Pref-gated (the captions
          control above) and absolutely positioned, so it never shifts the
          avatar and stays absent by default. */}
      <VoiceAmbientTranscript />

      {/* Room controls — captions toggle, minimize, and the persistent exit.
          Rendered above all room chrome; ✕ is never gated behind avatar
          readiness, so ending works even mid-load / on failure. */}
      <div
        // Absolute position is relative to the padding box, so the overlay's
        // safe-area padding does not shift this — inset it from the notch /
        // Dynamic Island directly, clamped to the desktop 1.25rem gap.
        style={{
          top: `max(1.25rem, ${SAFE_AREA_TOP})`,
          right: `max(1.25rem, ${SAFE_AREA_RIGHT})`,
        }}
        className="absolute z-10 flex items-center gap-1"
      >
        <Tooltip content={captionsOn ? "Hide captions" : "Show captions"}>
          <button
            type="button"
            onClick={toggleCaptions}
            aria-label={captionsOn ? "Hide captions" : "Show captions"}
            aria-pressed={captionsOn}
            className={ROOM_CONTROL_CLASS}
          >
            {captionsOn ? (
              <Captions className="size-5" />
            ) : (
              <CaptionsOff className="size-5" />
            )}
          </button>
        </Tooltip>
        <Tooltip content="Minimize (Esc)">
          <button
            type="button"
            onClick={minimizeLiveVoiceRoom}
            aria-label="Minimize voice room"
            className={ROOM_CONTROL_CLASS}
          >
            <Minimize2 className="size-5" />
          </button>
        </Tooltip>
        <Tooltip content="End voice session">
          <button
            type="button"
            onClick={endLiveVoiceSession}
            aria-label="Exit voice session"
            className={ROOM_CONTROL_CLASS}
          >
            <X className="size-5" />
          </button>
        </Tooltip>
      </div>

      {/* The avatar springs to center once on entry (the wrapper owns the
          one-time entry spring); per-state expression is the avatar's own CSS
          loop, which cross-fades in place without re-popping. */}
      <motion.div
        className="relative z-0"
        initial={reduce ? false : { scale: 0.8, y: 24, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={reduce ? { duration: 0 } : AVATAR_ENTER_SPRING}
      >
        <VoiceAvatar
          assistantId={assistantId}
          visual={visual}
          // Only the `responding` avatar is audio-reactive, and it always rides
          // TTS output — so the output amplitude is the sole source here. The
          // user's voice is expressed by the bottom waves in `listening`, not
          // by the avatar.
          getAmplitude={getLiveVoiceOutputAmplitude}
          size={AVATAR_SIZE}
        />
      </motion.div>

      {/* Connect feedback: until the session reaches `listening` the avatar
          shows the idle visual, which otherwise reads as dead air — surface
          the "Connecting…" / "Reconnecting…" label so the user knows when to
          start talking. aria-hidden: the sr-only live region below already
          announces every state change. */}
      <AnimatePresence>
        {state === "connecting" ? (
          <motion.p
            key="connect-label"
            data-testid="voice-room-connect-label"
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[calc(50%+8.5rem)] z-0 -translate-x-1/2 text-sm text-[var(--content-tertiary)]"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            {stateLabel}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen. */}
      <div aria-live="polite" className="sr-only">
        {stateLabel}
      </div>
    </motion.div>
  );
}
