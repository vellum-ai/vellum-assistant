/**
 * "Voice room" — the owning-composer surface for a live-voice session,
 * mounted by `chat-layout.tsx` as a purely additive overlay: the composer's
 * voice bar and display transcript still render underneath, hidden by this
 * layer, so removing the room leaves the old UI intact.
 *
 * Two looks, resolved per session assistant ({@link resolveVoiceRoomLook}):
 *
 * - Character avatars get the onboarding "full-screen color with eyes"
 *   treatment — the avatar color fills the room and the avatar's giant eyes
 *   peek from the bottom edge, with the control chrome toned for contrast
 *   against that color ({@link toneForBg}, via the `--room-*` CSS vars).
 * - Custom-image / no-character avatars fall back to the deep-dark ambient
 *   void with the state-driven avatar at its center and the listening waves —
 *   what this look should become is an open design question.
 *
 * The room is a full-app takeover on every platform — `fixed inset-0`, modal,
 * covering the header and sidebar, with safe-area padding for notched iOS
 * shells. A voice session IS the room: there is no minimize and no way to
 * leave it while the session runs — ending the session (the ✕ control) is the
 * only way out.
 *
 * Visibility is a pure function of {@link useIsVoiceRoomVisible} — active
 * session, owned by the on-screen composer, main window. Any session end
 * (user exit, `failed`, conversation timeout, stop from elsewhere) flips that
 * predicate false and unmounts the room; a `failed` session surfaces through
 * the existing composer Notice / pill failure chip, never a dead room.
 *
 * Sessions are hands-free (server-VAD): the user just speaks, so there is no
 * push-to-talk control. Bottom-center carries the session controls in the
 * call-app idiom: a mic mute toggle (always) and, while the assistant speaks
 * hands-free, a turn-scoped ■ stop. Exit is first-class: a persistent
 * ✕ control (always rendered, even while the avatar/assistant data is loading
 * or failed) ends the session. Escape deliberately does nothing — an
 * accidental keypress must not end a live call.
 */

import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Captions, CaptionsOff, Mic, MicOff, Square, X } from "lucide-react";

import { Tooltip, cn } from "@vellumai/design-library";

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  liveVoiceStateLabel,
  setLiveVoiceMuted,
  stopLiveVoiceResponse,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { toneForBg } from "@/utils/surface-tone";

import { resolveWaveAccentHex } from "./wave-accent";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceListeningWaves } from "./voice-listening-waves";
import { AVATAR_ENTER_SPRING } from "./voice-motion";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import { VoiceRoomEyes, resolveVoiceRoomLook } from "./voice-room-eyes";
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

/**
 * Shared treatment for the room's top icon controls, toned to the active look
 * via the `--room-*` vars set on the root (white-on-dark for the void look,
 * tone-derived over an avatar color).
 */
const ROOM_CONTROL_CLASS =
  "flex size-10 items-center justify-center rounded-full text-[var(--room-fg-muted)] transition hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]";

/** Bottom-row circular session controls (mute / ■ stop), same toning. */
const SESSION_CONTROL_CLASS =
  "flex size-12 items-center justify-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]";
const SESSION_CONTROL_NEUTRAL_CLASS =
  "border-[var(--room-border)] text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]";

export function VoiceRoom() {
  const visible = useIsVoiceRoomVisible();

  return (
    <AnimatePresence>
      {visible ? <VoiceRoomOverlay key="voice-room" /> : null}
    </AnimatePresence>
  );
}

/**
 * The mounted room. Split from {@link VoiceRoom} so its store subscriptions
 * only exist while the room is actually visible and are torn down cleanly on
 * exit.
 */
function VoiceRoomOverlay() {
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const muted = useLiveVoiceStore.use.muted();
  // Turn-scoped ■ stop is hands-free-only (a manual session's interrupt ends
  // the whole session); room sessions are hands-free except on the
  // version-skew fallback against an older daemon.
  const handsFree = useLiveVoiceStore.use.handsFree();
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

  // Resolve the assistant's look: color-with-eyes for character avatars, the
  // ambient void otherwise. The accent var is still published for the
  // fallback look's listening waves (null for custom-image / "none" /
  // still-loading avatars, where the waves keep their aurora fallback).
  const { components, traits, customImageUrl } = useAssistantAvatar(assistantId);
  const look = resolveVoiceRoomLook(components, traits, customImageUrl);
  const tone = look ? toneForBg(look.bgHex) : null;
  const accentHex = resolveWaveAccentHex(components, traits);

  // Control-chrome colors for the active look, consumed by the shared control
  // classes. The fallbacks are the void look's white-on-dark values.
  const toneVars = {
    "--room-fg": tone?.fg ?? "#FFFFFF",
    "--room-fg-muted": tone?.fgMuted ?? "rgba(255,255,255,0.7)",
    "--room-wash": tone?.wash ?? "rgba(255,255,255,0.1)",
    "--room-border": tone?.wash ?? "rgba(255,255,255,0.15)",
  } as CSSProperties;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
      // Theme tokens (the connect label, the ambient transcript) follow the
      // look: dark over the void and the dark avatar colors, light over the
      // light one (yellow).
      data-theme={tone?.isLight ? "light" : "dark"}
      role="dialog"
      aria-modal
      aria-label="Voice session"
      // The overlay covers `ChatLayoutHeader`, so it loses the header's
      // safe-area protection — pad the centered avatar inside the
      // notch/home-indicator per docs/CAPACITOR.md. The background layers are
      // `absolute inset-0` and stay full-bleed behind the padding.
      style={{
        paddingTop: SAFE_AREA_TOP,
        paddingBottom: SAFE_AREA_BOTTOM,
        paddingLeft: SAFE_AREA_LEFT,
        paddingRight: SAFE_AREA_RIGHT,
        ...toneVars,
        ...(accentHex ? { [AVATAR_ACCENT_CSS_VAR]: accentHex } : {}),
      }}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.4 }}
    >
      {look ? (
        <div
          className="absolute inset-0"
          style={{ backgroundColor: look.bgHex }}
        />
      ) : (
        <VoiceRoomAmbientBackground />
      )}

      {/* The assistant's giant eyes peeking from the bottom — the color look's
          entire cast. The void look expresses the session through the centered
          avatar and the listening waves instead. */}
      {look ? <VoiceRoomEyes art={look.art} /> : null}

      {/* Listening waves: the user's voice arriving as energy coming in, rising
          from the bottom edge with live mic amplitude. Void look only, while
          listening; responding expresses itself through the avatar's own
          emanation. Sits above the void, behind the centered avatar. */}
      {!look && visual === "listening" ? (
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

      {/* Room controls — captions toggle and the persistent exit. Rendered
          above all room chrome; ✕ is never gated behind avatar readiness, so
          ending works even mid-load / on failure. */}
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

      {/* Void look: the avatar springs to center once on entry (the wrapper
          owns the one-time entry spring); per-state expression is the avatar's
          own CSS loop, which cross-fades in place without re-popping. The
          color look has no centered figure — the bottom eyes are the cast. */}
      {!look ? (
        <motion.div
          className="relative z-0"
          initial={reduce ? false : { scale: 0.8, y: 24, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          transition={reduce ? { duration: 0 } : AVATAR_ENTER_SPRING}
        >
          <VoiceAvatar
            assistantId={assistantId}
            visual={visual}
            // Only the `responding` avatar is audio-reactive, and it always
            // rides TTS output — so the output amplitude is the sole source
            // here. The user's voice is expressed by the bottom waves in
            // `listening`, not by the avatar.
            getAmplitude={getLiveVoiceOutputAmplitude}
            size={AVATAR_SIZE}
          />
        </motion.div>
      ) : null}

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

      {/* Bottom-center session controls, the call-app idiom: the mic mute
          toggle always (an open mic demands an always-reachable mute), and —
          while the assistant speaks in a hands-free session — a ■ that stops
          the response without ending the session (web barge-in by just
          talking is not reliable yet, so this is the room's only interrupt). */}
      <div
        className="absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-3"
        style={{ bottom: `max(2.5rem, ${SAFE_AREA_BOTTOM})` }}
      >
        <Tooltip content={muted ? "Unmute microphone" : "Mute microphone"}>
          <button
            type="button"
            onClick={() => setLiveVoiceMuted(!muted)}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            className={cn(
              SESSION_CONTROL_CLASS,
              muted
                ? tone?.isLight
                  ? "border-red-700/50 bg-red-600/15 text-red-800 hover:bg-red-600/25"
                  : "border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30"
                : SESSION_CONTROL_NEUTRAL_CLASS,
            )}
          >
            {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </button>
        </Tooltip>
        <AnimatePresence>
          {handsFree && state === "speaking" ? (
            <motion.div
              key="stop-response"
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
            >
              <Tooltip content="Stop assistant response">
                <button
                  type="button"
                  onClick={stopLiveVoiceResponse}
                  aria-label="Stop assistant response"
                  className={cn(
                    SESSION_CONTROL_CLASS,
                    SESSION_CONTROL_NEUTRAL_CLASS,
                  )}
                >
                  <Square className="size-4" fill="currentColor" />
                </button>
              </Tooltip>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen. */}
      <div aria-live="polite" className="sr-only">
        {muted ? `Muted — ${stateLabel}` : stateLabel}
      </div>
    </motion.div>
  );
}
