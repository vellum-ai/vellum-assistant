import { useTranslation } from "@/i18n";
/**
 * Minimized live-voice surface: while a session is active and the room is
 * dismissed, this bar sits directly above the chat input on the owning thread.
 *
 * It sits *above* the composer rather than inside it, and the composer stays a
 * working composer underneath: the textarea is live, and attach / model picker
 * / send all work, so a user can type mid-session without ending it. That is
 * what fixes the bar's height: it no longer stands in for the composer's own
 * footprint, so it takes a single control row.
 *
 * Its corners are the chat input's ({@link COMPOSER_RADIUS_CLASS}), not the
 * capsule the header pill wears. The two radii carry a meaning: the pill is
 * round because it appears on pages the session did not start on and has to
 * read as "not from here", a visitor from another thread. On the session's own
 * conversation there is nothing foreign to announce — the bar belongs to the
 * composer it is stacked on, so it takes that card's corners and the two read
 * as one control area. That is per width, not once: the card is a deep pill at
 * mobile widths, and the bar wears the pill's radius there.
 *
 * It paints itself (the session assistant's avatar color, or
 * {@link VOICE_SURFACE_DARK} for an assistant with no character color), with the
 * mesh band running through it, so the room, this bar and the header pill are
 * one surface at three sizes. The composer under it keeps the app's normal card
 * surface: it is an input the user is expected to type into, not part of the
 * room.
 *
 * The band is the bar's whole readout. It is inked the way the room inks its
 * two: the user lifts a pale sheet off the floor while the mic is live, the
 * assistant answers in a darker one, and in silence the floor is empty. Nothing
 * is painted over it, so the bar says what it is doing by moving; the state
 * string reaches assistive tech through an `sr-only` live region instead.
 *
 * Because the bar is painted in an arbitrary avatar color, its chrome cannot use
 * theme tokens: the paint publishes `--room-*` (the same contract the room and
 * the pill use) and everything here reads those. The band cannot take the avatar
 * accent for the same reason. It would be the fill's own hue and paint nothing
 * at all.
 *
 * The controls sit quiet at the edges so the color and the band hold the middle,
 * and they are the room's own set at bar scale: mute the mic on the left, and on
 * the right mute the assistant and end. The two mutes are a symmetric pair, one
 * per direction of the conversation, and every control is persistent, so none of
 * them moves out from under a reaching finger mid-turn.
 *
 * **Returning to the room is the band itself**, not a fourth icon: tapping the
 * centre reopens it. That region is the bar's largest by a wide margin, and
 * "show me the session again" is the most likely thing to want from a minimized
 * one, so it gets the target that needs no aim — the same trade the title-bar
 * pill already makes with its own centre.
 *
 * Purely presentational: the composer observes the live-voice store and wires
 * `state`, the two amplitude poll functions, and the callbacks. Ending is
 * always available.
 *
 * There is no manual "send now": turns release themselves (server VAD
 * hands-free, auto-release in the manual fallback), so a send button would
 * advertise an action the user never needs.
 */

import type { CSSProperties } from "react";

import { Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

import {
  isLiveVoiceMicLive,
  liveVoiceSurfaceLabelKey,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  COMPOSER_MOBILE_RADIUS_CLASS,
  COMPOSER_RADIUS_CLASS,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import { VOICE_WAVE_EDGE_FADE_CLASS } from "@/domains/chat/voice/voice-room/voice-listening-waves";
import {
  MESH_INLINE_TUNING,
  VoiceMeshWaves,
} from "@/domains/chat/voice/voice-room/voice-mesh-waves";
import { BAND_VOICE } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import {
  VOICE_SURFACE_CONTROL_CLASS,
  voiceSurfaceMutedInk,
  voiceSurfaceStyle,
  voiceSurfaceTheme,
  type VoiceSurfacePaint,
} from "@/domains/chat/voice/voice-room/voice-surface-paint";
import { useIsMobile } from "@/hooks/use-is-mobile";

// Between turns (mic muted, assistant silent) the band reads a steady zero,
// which is the room's empty floor: no ink at all until a voice is present.
const SILENT_AMPLITUDE = () => 0;

/**
 * Bar height: one control row, not a composer footprint. 40px is the icon
 * chrome plus its breathing room, and it stops the bar from eating a second
 * composer's worth of the thread now that the real composer is still on screen
 * beneath it. Touch takes the extra 4px the expanded tap targets want.
 */
const BAR_HEIGHT_CLASS = "h-10 touch-mobile:h-11";

export interface VoiceComposerBarProps {
  state: LiveVoiceSessionState;
  /** Mic level, polled ~30 Hz by the band's draw loop. No re-render per sample. */
  getAmplitude: () => number;
  /**
   * Assistant-playback level, same polling contract. The band rides this while
   * the assistant speaks, so the bar keeps moving through the half of the
   * turn the mic is silent for, exactly as the room's two bands do.
   */
  getOutputAmplitude: () => number;
  /** Whether the mic is muted — drives the left-side mute toggle. */
  muted: boolean;
  /** Toggle the mic mute without ending the session. */
  onToggleMute: () => void;
  /** Red ✕ — end the voice session. */
  onEnd: () => void;
  /** Whether the assistant's audio is muted. Drives the right-side toggle. */
  outputMuted: boolean;
  /**
   * Mute (or unmute) the assistant without ending the session or stopping the
   * reply. The turn keeps running and the transcript keeps filling, so
   * unmuting drops the user back in wherever it has reached.
   */
  onToggleOutputMute: () => void;
  /**
   * Return to the full-screen voice room, invoked by tapping the bar's centre.
   * The composer passes it only where the room can render (never in pop-out
   * windows); absent, the centre is inert rather than a button that does
   * nothing.
   */
  onExpand?: () => void;
  /**
   * The room's fill and its foreground tones. Null until the session
   * assistant's avatar resolves, which is when the bar holds the app's own
   * lift surface instead — so it changes color once rather than flashing
   * through the ambient dark.
   */
  paint?: VoiceSurfacePaint | null;
}

export function VoiceComposerBar({
  state,
  getAmplitude,
  getOutputAmplitude,
  muted,
  onToggleMute,
  outputMuted,
  onToggleOutputMute,
  onEnd,
  onExpand,
  paint = null,
}: VoiceComposerBarProps) {
  const { t } = useTranslation("chat");
  // The card below is a pill at mobile widths, so the bar follows it there.
  const isMobile = useIsMobile();
  // Which voice the band is drawing, in the room's own terms: the user lifts a
  // pale sheet off the floor, the assistant answers in a darker one, and in
  // silence the floor is empty. Ink cannot come from the avatar accent here:
  // the bar is painted that exact color, so an accent-tinted band is the
  // fill's own hue and paints nothing at all.
  //
  // The reply wins the surface while it plays. The mic stays open through it
  // for barge-in (`isLiveVoiceMicLive` spans listening→speaking), so keying off
  // the mic alone would draw the user's voice over the assistant's.
  const replying = state === "speaking";
  const micLive = isLiveVoiceMicLive(state) && !muted;
  const ink = replying ? BAND_VOICE.responding : BAND_VOICE.listening;
  const bandAmplitude = replying
    ? getOutputAmplitude
    : micLive
      ? getAmplitude
      : SILENT_AMPLITUDE;
  // A muted control has to stay visible on the fill it sits on, so "off" is a
  // red chosen against that fill rather than the theme's negative token.
  const mutedInk = {
    "--vbtn-fg": voiceSurfaceMutedInk(paint),
  } as CSSProperties;
  // The session's own word, taken as a catalog key so the live region reads in
  // the user's language. The bar is handed a phase and a mute flag and nothing
  // else, so the reconnect and assistant-audio remaps are handed the values
  // that leave them unfired. Mute keeps the branch at the region below: this
  // bar says "Muted" in every phase, not only the one the session relabels.
  const stateKey = liveVoiceSurfaceLabelKey(state, false, true, false);
  return (
    <div
      role="group"
      aria-label={t("voiceComposerBar.ariaLabel")}
      data-theme={voiceSurfaceTheme(paint)}
      style={paint ? voiceSurfaceStyle(paint) : undefined}
      className={cn(
        "relative flex w-full items-center gap-1 overflow-hidden px-2 transition-colors duration-300",
        BAR_HEIGHT_CLASS,
        isMobile ? COMPOSER_MOBILE_RADIUS_CLASS : COMPOSER_RADIUS_CLASS,
        // Until the avatar resolves there is no room color to paint, so the
        // bar holds the app's own raised surface.
        !paint && "bg-[var(--surface-lift)]",
      )}
    >
      {/* The mesh band fills the bar rather than sitting in a middle column,
          so the color and the motion read as one surface. Behind the controls,
          which is why it is first and inert. */}
      <div
        data-testid="voice-session-band"
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden",
          VOICE_WAVE_EDGE_FADE_CLASS,
        )}
      >
        <VoiceMeshWaves
          getAmplitude={bandAmplitude}
          color={ink.color}
          peakOpacity={ink.peakOpacity}
          placement="inline"
          tuning={{ ...MESH_INLINE_TUNING, opacityKnee: ink.opacityKnee }}
        />
      </div>

      <div className="relative flex shrink-0 items-center">
        <Button
          variant="ghost"
          iconOnly={
            muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />
          }
          expandOnMobile
          onClick={onToggleMute}
          aria-label={muted ? t("voiceComposerBar.unmuteMicrophone") : t("voiceComposerBar.muteMicrophone")}
          aria-pressed={muted}
          tooltip={muted ? t("voiceComposerBar.unmuteMicrophone") : t("voiceComposerBar.muteMicrophone")}
          className={VOICE_SURFACE_CONTROL_CLASS}
          style={muted ? mutedInk : undefined}
        />
      </div>

      {/* The band holds the middle, and the middle is the way back into the
          room. Nothing is painted over it: the bar says what it is doing by
          moving, and the state string reaches assistive tech through the live
          region below.

          It is the bar's largest region by a wide margin, sitting between two
          clusters of 16px icons, so making it the target for the single most
          likely thing to want from a minimized session — see it again — beats
          a fourth icon competing for the same rail. The same reasoning the
          title-bar pill already follows for its own centre.

          A real `button`, not a click handler on the band: this is the one
          affordance here with no glyph to announce it, so it needs a role and
          a name or it exists for pointers only. Inert in pop-out windows,
          where there is no room to open — a `div` then, rather than a button
          that does nothing. */}
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          aria-label={t("voiceComposerBar.openVoiceRoom")}
          className="relative min-w-0 flex-1 self-stretch focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--vbtn-fg)]"
        />
      ) : (
        <div className="relative min-w-0 flex-1" />
      )}
      <span aria-live="polite" className="sr-only">
        {muted ? t("voiceComposerBar.muted") : stateKey ? t(stateKey) : ""}
      </span>

      <div className="relative flex shrink-0 items-center gap-1">
        {/* Mute the assistant, the room's own pairing for the mic mute: one
            control per direction of the conversation, both persistent, so
            neither moves out from under a reaching finger mid-turn. */}
        <Button
          variant="ghost"
          iconOnly={
            outputMuted ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )
          }
          expandOnMobile
          onClick={onToggleOutputMute}
          aria-label={outputMuted ? t("voiceComposerBar.unmuteAssistant") : t("voiceComposerBar.muteAssistant")}
          aria-pressed={outputMuted}
          tooltip={outputMuted ? t("voiceComposerBar.unmuteAssistant") : t("voiceComposerBar.muteAssistant")}
          className={VOICE_SURFACE_CONTROL_CLASS}
          style={outputMuted ? mutedInk : undefined}
        />
        <Button
          variant="ghost"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          expandOnMobile
          onClick={onEnd}
          aria-label={t("voiceComposerBar.endSession")}
          tooltip={t("voiceComposerBar.endSession")}
          className={VOICE_SURFACE_CONTROL_CLASS}
        />
      </div>
    </div>
  );
}
