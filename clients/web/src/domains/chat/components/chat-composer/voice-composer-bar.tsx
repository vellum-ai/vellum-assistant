/**
 * Minimized live-voice surface (Light 740 desktop, Light 741 mobile): while a
 * session is active and the room is dismissed, this block is the composer.
 *
 * It is a block, not a toolbar. The whole chat input is given over to it,
 * painted in the room's own background color (the session assistant's avatar
 * color, or {@link VOICE_SURFACE_DARK} for an assistant with no character
 * color), with the mesh band running through it. Minimizing therefore reads as
 * the room shrinking into the composer rather than as a row swap, and expanding
 * is the same surface growing back.
 *
 * The band is the block's whole readout. It is inked the way the room inks its
 * two: the user lifts a pale sheet off the floor while the mic is live, the
 * assistant answers in a darker one, and in silence the floor is empty. Nothing
 * is painted over it, so the block says what it is doing by moving; the state
 * string reaches assistive tech through an `sr-only` live region instead.
 *
 * Because the block is painted in an arbitrary avatar color, its chrome cannot
 * use theme tokens: the composer tones the card with `toneForBg` and publishes
 * `--room-*` (the same contract the room itself uses), and everything here
 * reads those. The band cannot take the avatar accent for the same reason. It
 * would be the fill's own hue and paint nothing at all. See `chat-composer.tsx`
 * for the card.
 *
 * The controls sit quiet at the edges so the color and the band hold the
 * middle, and they are the room's own set at block scale: mute the mic on the
 * left, and on the right mute the assistant, expand back to the room, and end.
 * The two mutes are a symmetric pair, one per direction of the conversation,
 * and every control is persistent, so none of them moves out from under a
 * reaching finger mid-turn.
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

import { Maximize2, Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

import {
  LIVE_VOICE_STATE_LABELS,
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VOICE_WAVE_EDGE_FADE_CLASS } from "@/domains/chat/voice/voice-room/voice-listening-waves";
import {
  MESH_INLINE_TUNING,
  VoiceMeshWaves,
} from "@/domains/chat/voice/voice-room/voice-mesh-waves";
import { BAND_VOICE } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import { VOICE_SURFACE_CONTROL_CLASS } from "@/domains/chat/voice/voice-room/voice-surface-paint";

// Between turns (mic muted, assistant silent) the band reads a steady zero,
// which is the room's empty floor: no ink at all until a voice is present.
const SILENT_AMPLITUDE = () => 0;

export interface VoiceComposerBarProps {
  state: LiveVoiceSessionState;
  /** Mic level, polled ~30 Hz by the band's draw loop. No re-render per sample. */
  getAmplitude: () => number;
  /**
   * Assistant-playback level, same polling contract. The band rides this while
   * the assistant speaks, so the block keeps moving through the half of the
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
   * Return to the full-screen voice room. The composer passes it only where
   * the room can render (never in pop-out windows), so the control never
   * ships dead.
   */
  onExpand?: () => void;
  /**
   * Whether the card's fill is a light color, from the same `toneForBg` read
   * that paints it. Only the muted controls consult it: their red has to
   * contrast with the fill rather than with the theme.
   */
  fillIsLight: boolean;
  /**
   * Whether the block is the composer card's only content, which it is unless
   * the user opted into seeing their own words (the live transcript keeps the
   * textarea row above). Standing alone it owns the card's whole footprint and
   * takes the full block height; sharing the card it sits under the transcript
   * and only takes the control row's height.
   */
  standalone?: boolean;
}

/**
 * Block height when the surface owns the whole card, chosen to match the
 * footprint of the composer it replaces (one textarea row plus the action row).
 * Holding that height is what keeps minimizing from shifting the transcript
 * above it.
 */
const BLOCK_HEIGHT_CLASS = "h-[5.25rem]";

/**
 * Ink for a control that is currently *off* (mic muted, assistant muted).
 *
 * Not the negative theme token: that is a mid-tone red, and the block is
 * painted an arbitrary avatar color, so the two can land close enough that the
 * muted glyph disappears into the fill. This is the room's own choice instead,
 * a pale red on dark fills and a deep one on light, which keeps "off" legible
 * on every palette color.
 *
 * Applied as an inline style rather than another utility: it competes with the
 * resting `--vbtn-fg` in {@link VOICE_SURFACE_CONTROL_CLASS}, and two
 * arbitrary-property classes setting the same variable are ordered by
 * Tailwind's own sort, not by the order they are passed in. An inline style
 * outranks both, on touch as well as on desktop.
 */
function mutedInk(fillIsLight: boolean): CSSProperties {
  return {
    "--vbtn-fg": fillIsLight ? "#991B1B" : "#FCA5A5",
  } as CSSProperties;
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
  fillIsLight,
  standalone = false,
}: VoiceComposerBarProps) {
  // Which voice the band is drawing, in the room's own terms: the user lifts a
  // pale sheet off the floor, the assistant answers in a darker one, and in
  // silence the floor is empty. Ink cannot come from the avatar accent here:
  // the block is painted that exact color, so an accent-tinted band is the
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
  return (
    <div
      role="group"
      aria-label="Voice session"
      className={cn(
        "relative flex items-center gap-3 px-2",
        // Standing alone the block owns the card, so it takes the composer's
        // footprint. Sharing the card with the live transcript it stays a
        // control row under it.
        standalone ? BLOCK_HEIGHT_CLASS : "pb-2",
      )}
    >
      {/* The mesh band fills the block rather than sitting in a middle column,
          so the color and the motion read as one surface. Behind the controls
          and the state word, which is why it is first and inert. */}
      <div
        data-testid="voice-session-band"
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

      {/* pl-1 keeps the toggle roughly on the textarea's px-4 text inset. */}
      <div className="relative flex shrink-0 items-center gap-2 pl-1">
        <Button
          variant="ghost"
          iconOnly={
            muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />
          }
          onClick={onToggleMute}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          tooltip={muted ? "Unmute microphone" : "Mute microphone"}
          className={VOICE_SURFACE_CONTROL_CLASS}
          style={muted ? mutedInk(fillIsLight) : undefined}
        />
      </div>

      {/* The band holds the middle. Nothing is painted over it: the block says
          what it is doing by moving, and the state string reaches assistive
          tech through the live region below. */}
      <div className="relative min-w-0 flex-1" />
      <span aria-live="polite" className="sr-only">
        {muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
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
          onClick={onToggleOutputMute}
          aria-label={outputMuted ? "Unmute assistant" : "Mute assistant"}
          aria-pressed={outputMuted}
          tooltip={outputMuted ? "Unmute assistant" : "Mute assistant"}
          className={VOICE_SURFACE_CONTROL_CLASS}
          style={outputMuted ? mutedInk(fillIsLight) : undefined}
        />
        {onExpand ? (
          <Button
            variant="ghost"
            iconOnly={<Maximize2 className="h-4 w-4" />}
            onClick={onExpand}
            aria-label="Open voice room"
            tooltip="Open voice room"
            className={VOICE_SURFACE_CONTROL_CLASS}
          />
        ) : null}
        <Button
          variant="ghost"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onEnd}
          aria-label="End voice session"
          tooltip="End voice session"
          className={VOICE_SURFACE_CONTROL_CLASS}
        />
      </div>
    </div>
  );
}
