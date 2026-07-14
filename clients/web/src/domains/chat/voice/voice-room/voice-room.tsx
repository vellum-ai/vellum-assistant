/**
 * "Voice room" — the owning-composer surface for a live-voice session,
 * mounted by `chat-layout.tsx` as a purely additive overlay: the composer's
 * voice bar and display transcript still render underneath, hidden by this
 * layer, so removing the room leaves the old UI intact.
 *
 * Two looks, resolved per session assistant ({@link resolveVoiceRoomLook}):
 *
 * - Character avatars get the onboarding "full-screen color with eyes"
 *   treatment — entering the room plays the Introduction-step grow (the
 *   avatar's body springs from its on-screen size to BE the screen, the color
 *   fades in behind it, the giant eyes grow into the center; see
 *   {@link VoiceRoomColorLook}), the mic waveform swells behind the eyes while
 *   the user speaks, and the control chrome is toned for contrast against that
 *   color ({@link toneForBg}, via the `--room-*` CSS vars).
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
 * hands-free, a turn-scoped ■ stop. Exit is first-class: the persistent
 * ✕ control (always rendered, even while the avatar/assistant data is loading
 * or failed) and Escape both end the session — the room is modal with no
 * lesser dismissal, so the platform "leave" key maps to the only exit there
 * is. The key handler attaches only while the room is mounted.
 */

import { useEffect, useMemo, type CSSProperties } from "react";
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
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { Surface } from "@/domains/chat/types/types";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { toneForBg } from "@/utils/surface-tone";

import { resolveWaveAccentHex } from "./wave-accent";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceListeningWaves } from "./voice-listening-waves";
import { AVATAR_ENTER_SPRING } from "./voice-motion";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import {
  VoiceRespondingRings,
  VoiceRoomColorLook,
  VoiceStateCaption,
  resolveVoiceRoomLook,
} from "./voice-room-eyes";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

const AVATAR_SIZE = 220;
/**
 * State caption anchor for the void look — just below the centered avatar's
 * bottom edge (half its size from center, plus a gap), the void-look counterpart
 * to the color look's caption below the eyes. Sits above the assistant
 * transcript's `50% + 15vmin + 2.5rem` clearance on any typical viewport, and it
 * only shows when that transcript is off (see below), so the two never collide.
 */
const VOID_CAPTION_TOP = `calc(50% + ${AVATAR_SIZE / 2}px + 1.75rem)`;

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
  // `speaking` stays set across a mid-turn tool run; gate `responding` on audio
  // actually flowing so the room reads `thinking` while the tool works.
  const assistantAudioActive = useLiveVoiceStore.use.assistantAudioActive();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const muted = useLiveVoiceStore.use.muted();
  // Turn-scoped ■ stop is hands-free-only (a manual session's interrupt ends
  // the whole session); room sessions are hands-free except on the
  // version-skew fallback against an older daemon.
  const handsFree = useLiveVoiceStore.use.handsFree();
  // Viewport point the entrance grows from (the tapped voice button); null →
  // the color look falls back to its screen-center origin.
  const entryOrigin = useLiveVoiceStore.use.entryOrigin();
  const reduce = useReducedMotion();

  const visual = toVoiceAvatarVisual(state, reconnecting, assistantAudioActive);
  // The label + sr-only announcement must follow the same audio-aware mapping as
  // the visual: a silent mid-turn `speaking` (ack spoken, tool now running)
  // reads as "Thinking…", not "Speaking…", so screen-reader users aren't told
  // the assistant is talking while it's actually silent (JARVIS-1279).
  const labelState =
    state === "speaking" && !assistantAudioActive ? "thinking" : state;
  const stateLabel = liveVoiceStateLabel(labelState, reconnecting);

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

  // Global Escape, live only while the room is mounted: ends the session,
  // same as the ✕ — the room is modal with no lesser dismissal, so the
  // platform "leave" key maps to the only exit there is. It fires even when
  // the composer textarea (or any other focused element) still holds focus as
  // the room opens, so it is intentionally not guarded by the event target.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        endLiveVoiceSession();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      {/* The color look (body grow entrance + color fade + centered waves +
          centered eyes) is the entire cast; the void look expresses the
          session through the centered avatar, but shares the color look's
          foreground chrome — the listening waves sweep in from the same top edge
          and the same state caption names the beat below the centerpiece — so
          the room reads identically for a custom avatar bar the full-screen
          color + eyes. Both draw the waves only while `listening`, from live mic
          amplitude. */}
      {look ? (
        <VoiceRoomColorLook
          look={look}
          visual={visual}
          getAmplitude={getLiveVoiceInputAmplitude}
          getResponseAmplitude={getLiveVoiceOutputAmplitude}
          // Only the *assistant* transcript occupies the space below the eyes
          // (the user transcript floats above), so the state caption stands down
          // for that pref alone — enabling only user captions must not blank the
          // lower zone the caption fills.
          showStateCaption={!showAssistantTranscript}
          entryOrigin={entryOrigin}
        />
      ) : (
        <>
          <VoiceRoomAmbientBackground />
          {visual === "listening" ? (
            <VoiceListeningWaves
              getAmplitude={getLiveVoiceInputAmplitude}
              palette="accent"
              // Same top edge as the color look, above the centered avatar —
              // positional parity, only the aurora/accent color differs from the
              // color look's avatar-toned band.
              placement="top"
            />
          ) : null}
          {/* Responding: the same concentric rings the color look radiates from
              behind the eyes, here behind the centered avatar (both centered, so
              they emanate from the centerpiece the same way). Rendered before the
              avatar so it paints them behind it; rides the TTS-output amplitude. */}
          {visual === "responding" ? (
            <VoiceRespondingRings getAmplitude={getLiveVoiceOutputAmplitude} />
          ) : null}
          {/* Same state caption + gating as the color look (stands down only for
              the assistant-transcript pref), anchored below the centered avatar
              instead of the eyes. */}
          {!showAssistantTranscript ? (
            <VoiceStateCaption visual={visual} top={VOID_CAPTION_TOP} />
          ) : null}
        </>
      )}

      {/* Optional muted echo of the live transcript, floating above (user) and
          below (assistant) the centered avatar. Pref-gated (the captions
          control above) and absolutely positioned, so it never shifts the
          avatar and stays absent by default. */}
      <VoiceAmbientTranscript />

      {/* A pending OAuth connect surface raised by the (voice) turn. The
          transcript's own copy of this card is sealed behind the room's
          `pointer-events-none blur-sm` cover (chat-layout), so a live-voice
          turn that needs an account connected would strand the user — render a
          live, clickable instance here inside the modal instead. */}
      <VoiceRoomOAuthConnectSlot assistantId={assistantId} />

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
        <Tooltip content="End voice session (Esc)">
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

      {/* Bottom-right session controls, the call-app idiom: the mic mute
          toggle always (an open mic demands an always-reachable mute), and —
          while the assistant speaks in a hands-free session — a ■ that stops
          the response without ending the session (web barge-in by just
          talking is not reliable yet, so this is the room's only interrupt).
          Anchored bottom-right (the mic sits in the corner, the transient stop
          to its left) with an equal corner gap on both edges, matching the
          top-right cluster's 1.25rem inset. */}
      <div
        className="absolute z-10 flex items-center gap-3"
        style={{
          bottom: `max(1.25rem, ${SAFE_AREA_BOTTOM})`,
          right: `max(1.25rem, ${SAFE_AREA_RIGHT})`,
        }}
      >
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
      </div>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen. */}
      <div aria-live="polite" className="sr-only">
        {muted ? `Muted — ${stateLabel}` : stateLabel}
      </div>
    </motion.div>
  );
}

/**
 * The transcript surface the room re-hosts: the newest pending (not yet
 * completed) `oauth_connect` card. Read from the same transcript state the
 * chat body renders from, so completing it there (or from here — both go
 * through {@link handleSurfaceAction}) drops it from both instances at once.
 */
function usePendingOAuthConnectSurface(): Surface | null {
  const messages = useTranscriptMessages();
  return useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const match = messages[i]?.surfaces?.find(
        (s) => s.surfaceType === "oauth_connect" && !s.completed,
      );
      if (match) return match;
    }
    return null;
  }, [messages]);
}

/**
 * In-room mount of the active pending `oauth_connect` surface. The room is a
 * `fixed inset-0` modal over the sealed (`pointer-events-none`) transcript, so
 * the transcript's own card is invisible and unclickable during a session —
 * this is the only reachable Connect button while voice is live. Wired exactly
 * as {@link SurfaceRouter} wires it in the transcript (assistantId, the
 * assistant display name, {@link handleSurfaceAction}), so a connect here is
 * indistinguishable from one in the transcript. Renders nothing when no
 * `oauth_connect` is pending.
 */
function VoiceRoomOAuthConnectSlot({
  assistantId,
}: {
  assistantId: string | null;
}) {
  const surface = usePendingOAuthConnectSurface();
  const assistantName = useAssistantIdentityStore.use.name();
  if (!surface) return null;

  return (
    // The card floats above the room's centerpiece, clearing the bottom-corner
    // session controls; only the card itself takes pointer events so the rest
    // of the modal stays as it was.
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md">
        <OAuthConnectSurface
          surface={surface}
          onAction={handleSurfaceAction}
          assistantId={assistantId}
          assistantDisplayName={assistantName?.trim() || undefined}
        />
      </div>
    </div>
  );
}
