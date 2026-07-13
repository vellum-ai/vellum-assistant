/**
 * Voice-session composer bar (Light 53): while a live-voice session is
 * active the composer's action row is replaced by this bar — a mic mute
 * toggle and muted state label on the left, the dotted timeline waveform
 * filling the middle, and the session controls on the right: optional
 * expand (reopen the minimized room), optional ■ stop-response (while the
 * assistant speaks), end (✕), and send-now (↑).
 *
 * Purely presentational: the composer observes the live-voice store and
 * wires `state`, an amplitude poll function, and the callbacks. The green ↑
 * is a manual "send now" (turn release) and is only meaningful while the
 * session is listening; the red ✕ ends the session and is always available.
 *
 * Layout mirrors the composer's bottom action row (`px-2 pb-2`, regular
 * `h-8` icon buttons) so swapping the rows in during a session causes no
 * layout shift.
 */

import { ArrowUp, Maximize2, Mic, MicOff, Square, X } from "lucide-react";

import { Button } from "@vellumai/design-library";

import {
  LIVE_VOICE_STATE_LABELS,
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VoiceTimelineWaveform } from "@/domains/chat/voice/voice-timeline-waveform";

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
  /** Green ↑ — manually release the current turn (send now). */
  onSend: () => void;
  /**
   * ■ — stop the in-flight assistant response without ending the session.
   * Rendered only while `speaking`; the composer passes it only for
   * hands-free sessions, where the interrupt is turn-scoped.
   */
  onStop?: () => void;
  /**
   * Re-expand the minimized voice room. The composer passes this only while
   * the room is actually minimized — the one case where this bar is visible
   * AND the room could be reopened — so the control never dead-renders (e.g.
   * in pop-outs, where the room never mounts). Absent → no expand button.
   */
  onExpand?: () => void;
}

export function VoiceComposerBar({
  state,
  getAmplitude,
  muted,
  onToggleMute,
  onEnd,
  onSend,
  onStop,
  onExpand,
}: VoiceComposerBarProps) {
  return (
    <div
      role="group"
      aria-label="Voice session"
      className="flex items-center gap-3 px-2 pb-2"
    >
      {/* pl-1 keeps the toggle roughly on the textarea's px-4 text inset. */}
      <div className="flex shrink-0 items-center gap-2 pl-1">
        <Button
          variant="ghost"
          iconOnly={
            muted ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )
          }
          onClick={onToggleMute}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          tooltip={muted ? "Unmute microphone" : "Mute microphone"}
          className={
            muted ? "[--vbtn-fg:var(--system-negative-strong)]" : undefined
          }
        />
        {/* Muted placeholder styling — matches the textarea's placeholder. */}
        <span
          aria-live="polite"
          className="text-chat text-[var(--content-disabled)]"
        >
          {muted ? "Muted" : LIVE_VOICE_STATE_LABELS[state]}
        </span>
      </div>
      <VoiceTimelineWaveform
        getAmplitude={getAmplitude}
        active={isLiveVoiceMicLive(state)}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 items-center gap-1">
        {onExpand ? (
          <Button
            variant="ghost"
            iconOnly={<Maximize2 className="h-4 w-4" strokeWidth={2.5} />}
            onClick={onExpand}
            aria-label="Open voice room"
            tooltip="Open voice room"
          />
        ) : null}
        {onStop && state === "speaking" ? (
          <Button
            variant="primary"
            iconOnly={<Square className="h-3 w-3" fill="currentColor" />}
            onClick={onStop}
            aria-label="Stop assistant response"
            tooltip="Stop assistant response"
          />
        ) : null}
        <Button
          variant="danger"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onEnd}
          aria-label="End voice session"
        />
        <Button
          variant="primary"
          iconOnly={<ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onSend}
          disabled={state !== "listening"}
          aria-label="Send now"
        />
      </div>
    </div>
  );
}
