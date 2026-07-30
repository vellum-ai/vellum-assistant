/**
 * Minimized live-voice surface (Light 740 desktop, Light 741 mobile): while a
 * session is active and the room is dismissed, this block is the composer.
 *
 * It is a block, not a toolbar. The whole chat input is given over to it,
 * painted in the room's own background color (the session assistant's avatar
 * color, or {@link VOICE_SURFACE_DARK} for an assistant with no character
 * color), with the mesh band and the state word inside it. Minimizing therefore
 * reads as the room shrinking into the composer rather than as a row swap, and
 * expanding is the same surface growing back.
 *
 * Because the block is painted in an arbitrary avatar color, its chrome cannot
 * use theme tokens: the composer tones the card with `toneForBg` and publishes
 * `--room-*` (the same contract the room itself uses), and everything here
 * reads those. See `chat-composer.tsx` for the card.
 *
 * The controls sit quiet at the edges so the color and the band hold the
 * middle: mic mute on the left (stop input), and on the right the stop slot
 * (stop output, present only while the assistant speaks), expand back to the
 * room, and end session.
 *
 * Purely presentational: the composer observes the live-voice store and wires
 * `state`, an amplitude poll function, and the callbacks. Ending is always
 * available.
 *
 * There is no manual "send now": turns release themselves (server VAD
 * hands-free, auto-release in the manual fallback), so a send button would
 * advertise an action the user never needs. Stop output earns its place because
 * interrupting a reply in progress has no silent equivalent.
 */

import { Maximize2, Mic, MicOff, Square, X } from "lucide-react";

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
  /**
   * ■ — stop the in-flight assistant response without ending the session.
   * Occupies the stop slot only while `speaking`; the composer passes it only
   * for hands-free sessions, where the interrupt is turn-scoped.
   */
  onStop?: () => void;
  /**
   * Return to the full-screen voice room. The composer passes it only where
   * the room can render (never in pop-out windows), so the control never
   * ships dead.
   */
  onExpand?: () => void;
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
 * Control chrome toned for the avatar color under it, via the `--room-*` vars
 * the composer publishes from `toneForBg`. Theme tokens cannot be used here:
 * the block is painted an arbitrary avatar color, so `--content-default` is as
 * likely to be invisible on it as legible. The token fallbacks only apply if a
 * caller renders the block without the vars, which the composer never does.
 */
const VOICE_CONTROL_CLASS = [
  "[--vbtn-fg:var(--room-fg-muted,var(--content-secondary))]",
  "hover:[--vbtn-fg:var(--room-fg,var(--content-default))]",
  "hover:bg-[var(--room-wash,var(--surface-hover))]",
].join(" ");

export function VoiceComposerBar({
  state,
  getAmplitude,
  getOutputAmplitude,
  muted,
  onToggleMute,
  onEnd,
  onStop,
  onExpand,
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
          className={cn(
            VOICE_CONTROL_CLASS,
            muted && "[--vbtn-fg:var(--system-negative-strong)]",
          )}
        />
      </div>

      {/* The state word, centered in the block over the band. `aria-hidden`
          because the live region below already announces it: rendering both
          would have a screen reader read the state twice. */}
      <div className="relative flex min-w-0 flex-1 items-center justify-center">
        <span
          aria-hidden
          className="truncate text-sm font-medium text-[var(--room-fg-muted,var(--content-secondary))]"
        >
          {muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
        </span>
      </div>
      <span aria-live="polite" className="sr-only">
        {muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
      </span>

      <div className="relative flex shrink-0 items-center gap-1">
        {/* Stop slot: interrupts a reply in progress, and is present only
            while one is playing. Nothing occupies the slot otherwise. */}
        {onStop && state === "speaking" ? (
          <Button
            variant="ghost"
            iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
            onClick={onStop}
            aria-label="Stop assistant response"
            tooltip="Stop assistant response"
            className={VOICE_CONTROL_CLASS}
          />
        ) : null}
        {onExpand ? (
          <Button
            variant="ghost"
            iconOnly={<Maximize2 className="h-4 w-4" />}
            onClick={onExpand}
            aria-label="Open voice room"
            tooltip="Open voice room"
            className={VOICE_CONTROL_CLASS}
          />
        ) : null}
        <Button
          variant="ghost"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onEnd}
          aria-label="End voice session"
          tooltip="End voice session"
          className={VOICE_CONTROL_CLASS}
        />
      </div>
    </div>
  );
}
