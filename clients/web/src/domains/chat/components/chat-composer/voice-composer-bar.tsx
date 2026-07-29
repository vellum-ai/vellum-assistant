/**
 * Voice-session composer bar (Light 53): while a live-voice session is
 * active the composer's action row is replaced by this bar — a mic mute
 * toggle on the left, the voice room's listening waves filling the middle
 * (the same layered accent-tinted band, scaled to the strip), and the
 * session controls on the right: optional expand back to the voice room,
 * end (✕), and the stop slot — ■ stop-response, present only while the
 * assistant speaks.
 *
 * Purely presentational: the composer observes the live-voice store and
 * wires `state`, an amplitude poll function, and the callbacks. The red ✕
 * ends the session and is always available.
 *
 * Textless, matching the title-bar pill: the mic glyph and the animating
 * waves carry the session state on their own, and the waves want the width on
 * a phone-width composer. The state string reaches assistive tech through an
 * `sr-only` live region instead.
 *
 * The bar offers no manual "send now" — turns release themselves (server VAD
 * hands-free, auto-release in the manual fallback), so a primary-weight send
 * button would advertise an action the user never needs. ■ earns its place:
 * interrupting a reply in progress has no silent equivalent.
 *
 * Layout mirrors the composer's bottom action row (`px-2 pb-2`, regular
 * `h-8` icon buttons) so swapping the rows in during a session causes no
 * layout shift.
 */

import type { CSSProperties } from "react";

import { Maximize2, Mic, MicOff, Square, X } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

import {
  LIVE_VOICE_STATE_LABELS,
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  VOICE_WAVE_EDGE_FADE_CLASS,
  VoiceListeningWaves,
} from "@/domains/chat/voice/voice-room/voice-listening-waves";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";

// While the mic is not live (muted, assistant speaking) the waves read a
// steady zero and settle into their quiet drift — the room's own resting
// listening band — instead of freezing.
const SILENT_AMPLITUDE = () => 0;

export interface VoiceComposerBarProps {
  state: LiveVoiceSessionState;
  /** Polled ~30 Hz by the waveform's draw loop — no re-render per sample. */
  getAmplitude: () => number;
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
   * Accent hex matching the avatar the voice room renders (see
   * `resolveWaveAccentHex`), so the bar's waves keep the room's tint.
   * Null/omitted falls back to the app-wide accent, then aurora.
   */
  waveAccentHex?: string | null;
  /**
   * Whether the bar is the composer card's only row — set when the textarea
   * collapses away for the session. The bar normally sits beneath the
   * textarea's own top padding; standing alone it has to supply its own, or
   * it renders flush against the card's top edge.
   */
  standalone?: boolean;
}

export function VoiceComposerBar({
  state,
  getAmplitude,
  muted,
  onToggleMute,
  onEnd,
  onStop,
  onExpand,
  waveAccentHex,
  standalone = false,
}: VoiceComposerBarProps) {
  return (
    <div
      role="group"
      aria-label="Voice session"
      className={cn("flex items-center gap-3 px-2 pb-2", standalone && "pt-3")}
    >
      {/* pl-1 keeps the toggle roughly on the textarea's px-4 text inset. */}
      <div className="flex shrink-0 items-center gap-2 pl-1">
        <Button
          variant="ghost"
          iconOnly={
            muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />
          }
          onClick={onToggleMute}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          tooltip={muted ? "Unmute microphone" : "Mute microphone"}
          className={
            muted ? "[--vbtn-fg:var(--system-negative-strong)]" : undefined
          }
        />
        {/* The bar paints no text, so the session state reaches assistive
            tech here instead. Announced on change, like the title-bar pill. */}
        <span aria-live="polite" className="sr-only">
          {muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
        </span>
      </div>
      {/* The room's listening-wave band, inline: needs a positioned box to
          fill (the component is absolutely positioned) and overflow-hidden so
          the drifting layers clip to the strip. */}
      <div
        className={cn(
          "relative h-6 min-w-0 flex-1 overflow-hidden",
          VOICE_WAVE_EDGE_FADE_CLASS,
        )}
        style={
          waveAccentHex
            ? ({ [AVATAR_ACCENT_CSS_VAR]: waveAccentHex } as CSSProperties)
            : undefined
        }
      >
        <VoiceListeningWaves
          getAmplitude={
            isLiveVoiceMicLive(state) ? getAmplitude : SILENT_AMPLITUDE
          }
          palette="accent"
          placement="inline"
        />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onExpand ? (
          <Button
            variant="ghost"
            iconOnly={<Maximize2 className="h-4 w-4" />}
            onClick={onExpand}
            aria-label="Open voice room"
            tooltip="Open voice room"
          />
        ) : null}
        <Button
          variant="danger"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onEnd}
          aria-label="End voice session"
        />
        {/* Stop slot: ■ interrupts a reply in progress, and is present only
            while one is playing — nothing occupies the slot otherwise. */}
        {onStop && state === "speaking" ? (
          <Button
            variant="primary"
            iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
            onClick={onStop}
            aria-label="Stop assistant response"
            tooltip="Stop assistant response"
          />
        ) : null}
      </div>
    </div>
  );
}
